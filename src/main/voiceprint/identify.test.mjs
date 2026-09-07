import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createSessionStore } from "../store/sessions.ts";
import { addVoiceprint } from "./book.ts";
import { identifySession } from "./identify.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function vec(...values) {
  return new Float32Array(values);
}

function writeToneWav(path, seconds) {
  const samples = seconds * 16000;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  writeFileSync(path, buf);
}

function sessionWithCluster(store) {
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  store.patchJobs(created.id, { speakers: { status: "done", current: "speakers-v1.json" } });
  const dir = store.sessionDir(created.id);
  writeToneWav(join(dir, "system.wav"), 8);
  writeFileSync(
    join(dir, "speakers-v1.json"),
    `${JSON.stringify({
      speakers: ["小 A"],
      clusters: [{ speaker: "小 A", segments: [{ startMs: 0, endMs: 8000 }] }],
    })}\n`,
  );
  return created.id;
}

test("identifySession skips the whole pass when the voice book is empty", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-id-"));
  const store = createSessionStore(root);
  const sessionId = sessionWithCluster(store);
  let called = 0;
  await identifySession({
    store,
    sessionId,
    embed: async () => {
      called += 1;
      throw new Error("embed should not run");
    },
  });
  assert.equal(called, 0);
  assert.deepEqual(store.readNames(sessionId), {});
  assert.equal(existsSync(join(store.sessionDir(sessionId), "auto-names.json")), false);
});

test("identifySession does not overwrite a name the user already set", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-id-"));
  const store = createSessionStore(root);
  const sessionId = sessionWithCluster(store);
  store.renameSpeaker({ sessionId, from: "小 A", to: "张三" });
  addVoiceprint(root, "王明", vec(1, 0, 0));
  await identifySession({
    store,
    sessionId,
    embed: async () => vec(1, 0, 0),
  });
  assert.equal(store.readNames(sessionId)["小 A"], "张三");
  assert.equal(existsSync(join(store.sessionDir(sessionId), "auto-names.json")), false);
});

test("identifySession writes a hit through renameSpeaker and records auto-names", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-id-"));
  const store = createSessionStore(root);
  const sessionId = sessionWithCluster(store);
  addVoiceprint(root, "王明", vec(1, 0, 0));
  await identifySession({
    store,
    sessionId,
    embed: async () => vec(1, 0, 0),
  });
  assert.equal(store.readNames(sessionId)["小 A"], "王明");
  const autoNames = JSON.parse(readFileSync(join(store.sessionDir(sessionId), "auto-names.json"), "utf8"));
  assert.equal(autoNames["小 A"], "王明");
  assert.equal(typeof autoNames["小 A"], "string");
});

test("identifySession does not embed without speakers.current or system.wav", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-id-"));
  const store = createSessionStore(root);
  addVoiceprint(root, "王明", vec(1, 0, 0));
  const noCurrent = store.createRecording();
  store.finalize(noCurrent.id, "complete");
  let called = 0;
  const embed = async () => {
    called += 1;
    return vec(1, 0, 0);
  };
  await identifySession({ store, sessionId: noCurrent.id, embed });
  assert.equal(called, 0);

  const noWav = sessionWithCluster(store);
  rmSync(join(store.sessionDir(noWav), "system.wav"));
  await identifySession({ store, sessionId: noWav, embed });
  assert.equal(called, 0);
  assert.deepEqual(store.readNames(noWav), {});
});

test("identifySession skips 你 clusters and segments shorter than 1s", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-id-"));
  const store = createSessionStore(root);
  addVoiceprint(root, "王明", vec(1, 0, 0));
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  store.patchJobs(created.id, { speakers: { status: "done", current: "speakers-v1.json" } });
  const dir = store.sessionDir(created.id);
  writeToneWav(join(dir, "system.wav"), 8);
  writeFileSync(
    join(dir, "speakers-v1.json"),
    `${JSON.stringify({
      speakers: ["你", "小 A"],
      clusters: [
        { speaker: "你", segments: [{ startMs: 0, endMs: 8000 }] },
        { speaker: "小 A", segments: [{ startMs: 0, endMs: 400 }] },
      ],
    })}\n`,
  );
  let called = 0;
  await identifySession({
    store,
    sessionId: created.id,
    embed: async () => {
      called += 1;
      return vec(1, 0, 0);
    },
  });
  assert.equal(called, 0);
  assert.deepEqual(store.readNames(created.id), {});
});

test("identifySession does not write a name when cosine is below 0.55", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-id-"));
  const store = createSessionStore(root);
  const sessionId = sessionWithCluster(store);
  addVoiceprint(root, "王明", vec(1, 0, 0));
  await identifySession({
    store,
    sessionId,
    embed: async () => vec(0, 1, 0),
  });
  assert.deepEqual(store.readNames(sessionId), {});
  assert.equal(existsSync(join(store.sessionDir(sessionId), "auto-names.json")), false);
});

test("identifySession gives a contested person to the higher-scoring cluster", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-id-"));
  const store = createSessionStore(root);
  addVoiceprint(root, "王明", vec(1, 0, 0));
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  store.patchJobs(created.id, { speakers: { status: "done", current: "speakers-v1.json" } });
  const dir = store.sessionDir(created.id);
  writeToneWav(join(dir, "system.wav"), 8);
  writeFileSync(
    join(dir, "speakers-v1.json"),
    `${JSON.stringify({
      speakers: ["小 A", "小 B"],
      clusters: [
        { speaker: "小 A", segments: [{ startMs: 0, endMs: 8000 }] },
        { speaker: "小 B", segments: [{ startMs: 0, endMs: 8000 }] },
      ],
    })}\n`,
  );
  let n = 0;
  await identifySession({
    store,
    sessionId: created.id,
    embed: async () => {
      n += 1;
      return n === 1 ? vec(0.9, 0.1, 0) : vec(1, 0, 0);
    },
  });
  const names = store.readNames(created.id);
  assert.equal(names["小 B"], "王明");
  assert.equal(names["小 A"], undefined);
});

test("identifySession does not write names when speakers file is empty or illegal", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-id-"));
  const store = createSessionStore(root);
  addVoiceprint(root, "王明", vec(1, 0, 0));
  const empty = store.createRecording();
  store.finalize(empty.id, "complete");
  store.patchJobs(empty.id, { speakers: { status: "done", current: "speakers-v1.json" } });
  writeToneWav(join(store.sessionDir(empty.id), "system.wav"), 8);
  writeFileSync(join(store.sessionDir(empty.id), "speakers-v1.json"), JSON.stringify({ turns: [] }));
  await identifySession({
    store,
    sessionId: empty.id,
    embed: async () => {
      throw new Error("embed should not run");
    },
  });
  assert.deepEqual(store.readNames(empty.id), {});

  const bad = store.createRecording();
  store.finalize(bad.id, "complete");
  store.patchJobs(bad.id, { speakers: { status: "done", current: "speakers-v1.json" } });
  writeToneWav(join(store.sessionDir(bad.id), "system.wav"), 8);
  writeFileSync(join(store.sessionDir(bad.id), "speakers-v1.json"), "not-json");
  await identifySession({
    store,
    sessionId: bad.id,
    embed: async () => vec(1, 0, 0),
  });
  assert.deepEqual(store.readNames(bad.id), {});
});

test("identifySession leaves names unchanged when embed is empty or throws", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-id-"));
  const store = createSessionStore(root);
  const emptyId = sessionWithCluster(store);
  addVoiceprint(root, "王明", vec(1, 0, 0));
  await identifySession({
    store,
    sessionId: emptyId,
    embed: async () => new Float32Array(),
  });
  assert.deepEqual(store.readNames(emptyId), {});

  const throwId = sessionWithCluster(store);
  await identifySession({
    store,
    sessionId: throwId,
    embed: async () => {
      throw new Error("embed boom");
    },
  });
  assert.deepEqual(store.readNames(throwId), {});
});
