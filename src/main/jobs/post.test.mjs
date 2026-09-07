import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createSessionStore } from "../store/sessions.ts";
import { addVoiceprint } from "../voiceprint/book.ts";
import { processSession } from "./post.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function tinyWav(path) {
  writeFileSync(path, Buffer.alloc(64));
}

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

test("processSession writes refined and speakers when auto diarize is on", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  tinyWav(join(store.sessionDir(created.id), "mic.wav"));
  tinyWav(join(store.sessionDir(created.id), "system.wav"));

  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "all",
    transcribe: async ({ filePath, diarize }) => {
      if (filePath.endsWith("mic.wav")) {
        assert.equal(diarize, false);
        return [{ tStartMs: 30, text: "我这边" }];
      }
      assert.equal(diarize, true);
      return [{ tStartMs: 10, text: "你好", speakerId: 0 }];
    },
  });

  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.status, "done");
  assert.equal(doc.jobs.refined.current, "refined-v1.json");
  assert.equal(doc.jobs.speakers.status, "done");
  assert.equal(doc.jobs.speakers.current, "speakers-v1.json");
  const refined = JSON.parse(readFileSync(join(store.sessionDir(created.id), "refined-v1.json"), "utf8"));
  assert.deepEqual(
    refined.turns.map((row) => row.speaker),
    ["小 A", "你"],
  );
  const speakers = JSON.parse(readFileSync(join(store.sessionDir(created.id), "speakers-v1.json"), "utf8"));
  assert.deepEqual(speakers.speakers, ["小 A"]);
  assert.equal(Array.isArray(speakers.clusters), true);
});

test("processSession skips diarization when autoDiarize is off", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-nodiar-"));
  const store = createSessionStore(root);
  store.setAutoDiarize(false);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  tinyWav(join(store.sessionDir(created.id), "system.wav"));

  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "all",
    transcribe: async ({ diarize }) => {
      assert.equal(diarize, false);
      return [{ tStartMs: 0, text: "对方", speakerId: 0 }];
    },
  });

  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.status, "done");
  assert.equal(doc.jobs.speakers.status, "idle");
  const refined = JSON.parse(readFileSync(join(store.sessionDir(created.id), "refined-v1.json"), "utf8"));
  assert.equal(refined.turns[0].speaker, "对方");
});

test("processSession marks failed and keeps the previous refined on speakers error", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-fail-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  store.patchJobs(created.id, { refined: { status: "done", current: "refined-v1.json" } });
  writeFileSync(
    join(store.sessionDir(created.id), "refined-v1.json"),
    JSON.stringify({ turns: [{ id: "old", track: "you", speaker: "你", tStartMs: 0, text: "旧" }] }),
  );
  tinyWav(join(store.sessionDir(created.id), "system.wav"));

  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "speakers",
    transcribe: async () => {
      throw new Error("boom");
    },
  });

  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.status, "done");
  assert.equal(doc.jobs.refined.current, "refined-v1.json");
  assert.equal(doc.jobs.speakers.status, "failed");
});

test("processSession reports classified failure reason", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-fail-reason-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  tinyWav(join(store.sessionDir(created.id), "system.wav"));
  const reasons = {};

  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "all",
    onFail: (job, msg) => {
      reasons[job] = msg;
    },
    transcribe: async () => {
      throw new Error("fetch failed ECONNREFUSED");
    },
  });

  assert.deepEqual(reasons, { refined: "网络不通", speakers: "网络不通" });
  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.status, "failed");
  assert.equal(doc.jobs.speakers.status, "failed");
});

test("processSession auto-names a cluster after speakers.current is stored", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-id-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  writeToneWav(join(store.sessionDir(created.id), "system.wav"), 8);
  addVoiceprint(root, "王明", vec(1, 0, 0));

  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "all",
    transcribe: async ({ filePath, diarize }) => {
      assert.equal(filePath.endsWith("system.wav"), true);
      assert.equal(diarize, true);
      return [{ tStartMs: 0, text: "你好", speakerId: 0 }];
    },
    embed: async () => vec(1, 0, 0),
  });

  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.status, "done");
  assert.equal(doc.jobs.speakers.status, "done");
  assert.equal(doc.jobs.speakers.current, "speakers-v1.json");
  assert.equal(store.readNames(created.id)["小 A"], "王明");
});

test("processSession abort persists neutral canceled jobs without failure reasons", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-abort-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  tinyWav(join(store.sessionDir(created.id), "system.wav"));
  const ac = new AbortController();
  const reasons = {};

  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "all",
    signal: ac.signal,
    onFail: (job, msg) => {
      reasons[job] = msg;
    },
    transcribe: async ({ signal }) => {
      ac.abort();
      if (signal?.aborted) {
        const err = new Error("已取消");
        err.name = "AbortError";
        throw err;
      }
      return [{ tStartMs: 0, text: "不该写完" }];
    },
  });

  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.status, "canceled");
  assert.equal(doc.jobs.speakers.status, "canceled");
  assert.deepEqual(reasons, {});
});

test("processSession keeps jobs done when voiceprint identify throws", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-idfail-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  writeToneWav(join(store.sessionDir(created.id), "system.wav"), 8);
  addVoiceprint(root, "王明", vec(1, 0, 0));

  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "all",
    transcribe: async () => [{ tStartMs: 0, text: "你好", speakerId: 0 }],
    identify: async () => {
      throw new Error("identify boom");
    },
  });

  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.status, "done");
  assert.equal(doc.jobs.speakers.status, "done");
});

test("nextArtifact returns v2 when refined-v1.json already exists", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-next-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  writeFileSync(join(store.sessionDir(created.id), "refined-v1.json"), JSON.stringify({ turns: [] }));
  assert.equal(store.nextArtifact(created.id, "refined"), "refined-v2.json");
});

test("processSession run twice points current at v2 and keeps v1 on disk", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-v2-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  tinyWav(join(store.sessionDir(created.id), "mic.wav"));
  tinyWav(join(store.sessionDir(created.id), "system.wav"));

  const transcribe = async ({ filePath }) => {
    if (filePath.endsWith("mic.wav")) return [{ tStartMs: 0, text: "我" }];
    return [{ tStartMs: 10, text: "你好", speakerId: 0 }];
  };
  await processSession({ apiKey: "sk-test", store, sessionId: created.id, mode: "all", transcribe });
  await processSession({ apiKey: "sk-test", store, sessionId: created.id, mode: "all", transcribe });

  const dir = store.sessionDir(created.id);
  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.current, "refined-v2.json");
  assert.equal(existsSync(join(dir, "refined-v1.json")), true);
  assert.equal(existsSync(join(dir, "refined-v2.json")), true);
});

test("processSession marks both jobs failed when neither wav has a body", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-nowav-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "all",
    transcribe: async () => {
      throw new Error("should not transcribe");
    },
  });
  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.status, "failed");
  assert.equal(doc.jobs.speakers.status, "failed");
});

test("processSession mic-only transcribes mic and writes speakers when autoDiarize is on", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-mic-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  tinyWav(join(store.sessionDir(created.id), "mic.wav"));
  const called = [];
  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "all",
    transcribe: async ({ filePath, diarize }) => {
      called.push({ track: filePath.endsWith("mic.wav") ? "mic" : "system", diarize });
      return [{ tStartMs: 0, text: "我这边" }];
    },
  });
  assert.deepEqual(called, [{ track: "mic", diarize: false }]);
  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.status, "done");
  assert.equal(doc.jobs.speakers.status, "done");
});

test("processSession mic-only skips speakers when autoDiarize is off", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-mic-off-"));
  const store = createSessionStore(root);
  store.setAutoDiarize(false);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  tinyWav(join(store.sessionDir(created.id), "mic.wav"));
  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "all",
    transcribe: async ({ filePath }) => {
      assert.equal(filePath.endsWith("mic.wav"), true);
      return [{ tStartMs: 0, text: "我" }];
    },
  });
  assert.equal(store.readSession(created.id).jobs.speakers.status, "idle");
  assert.equal(store.readSession(created.id).jobs.refined.status, "done");
});

test("processSession mode speakers reuses old refined you-track and only transcribes system", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-reuse-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  store.patchJobs(created.id, { refined: { status: "done", current: "refined-v1.json" } });
  writeFileSync(
    join(store.sessionDir(created.id), "refined-v1.json"),
    JSON.stringify({
      turns: [{ id: "old-you", track: "you", speaker: "你", tStartMs: 0, text: "旧麦" }],
    }),
  );
  tinyWav(join(store.sessionDir(created.id), "system.wav"));
  const called = [];
  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "speakers",
    transcribe: async ({ filePath, diarize }) => {
      called.push({ track: filePath.endsWith("mic.wav") ? "mic" : "system", diarize });
      return [{ tStartMs: 20, text: "新系统", speakerId: 0 }];
    },
  });
  assert.deepEqual(called, [{ track: "system", diarize: true }]);
  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.current, "refined-v2.json");
  assert.equal(doc.jobs.speakers.current, "speakers-v1.json");
  const refined = JSON.parse(readFileSync(join(store.sessionDir(created.id), "refined-v2.json"), "utf8"));
  assert.deepEqual(
    refined.turns.map((row) => [row.speaker, row.text]),
    [
      ["你", "旧麦"],
      ["小 A", "新系统"],
    ],
  );
  assert.equal(existsSync(join(store.sessionDir(created.id), "speakers-v1.json")), true);
});

test("processSession mode speakers without old refined still transcribes mic", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-spk-mic-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  tinyWav(join(store.sessionDir(created.id), "mic.wav"));
  const called = [];
  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "speakers",
    transcribe: async ({ filePath }) => {
      called.push(filePath.endsWith("mic.wav") ? "mic" : "system");
      return [{ tStartMs: 0, text: "我" }];
    },
  });
  assert.deepEqual(called, ["mic"]);
  assert.equal(store.readSession(created.id).jobs.refined.status, "done");
});

test("processSession system-only does not transcribe mic", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-sys-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  tinyWav(join(store.sessionDir(created.id), "system.wav"));
  const called = [];
  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "all",
    transcribe: async ({ filePath, diarize }) => {
      called.push({ track: filePath.endsWith("mic.wav") ? "mic" : "system", diarize });
      return [{ tStartMs: 0, text: "你好", speakerId: 0 }];
    },
  });
  assert.deepEqual(called, [{ track: "system", diarize: true }]);
});

test("processSession drops stale names after a speakers rerun", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-prune-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  tinyWav(join(store.sessionDir(created.id), "system.wav"));
  writeFileSync(join(store.sessionDir(created.id), "names.json"), `${JSON.stringify({ "小 A": "王明" }, null, 2)}\n`);
  writeFileSync(join(store.sessionDir(created.id), "auto-names.json"), `${JSON.stringify({ "小 A": "王明" }, null, 2)}\n`);

  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "all",
    transcribe: async () => [{ tStartMs: 0, text: "你好", speakerId: 1 }],
  });

  assert.equal(store.readNames(created.id)["小 A"], undefined);
  assert.equal(store.readNames(created.id)["小 B"], undefined);
  const autoNames = JSON.parse(readFileSync(join(store.sessionDir(created.id), "auto-names.json"), "utf8"));
  assert.equal(autoNames["小 A"], undefined);
});

test("processSession identify rematches a pruned name via voiceprint", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-remap-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  writeToneWav(join(store.sessionDir(created.id), "system.wav"), 8);
  writeFileSync(join(store.sessionDir(created.id), "names.json"), `${JSON.stringify({ "小 A": "王明" }, null, 2)}\n`);
  addVoiceprint(root, "王明", vec(1, 0, 0));

  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "all",
    transcribe: async () => [{ tStartMs: 0, text: "你好", speakerId: 1 }],
    embed: async () => vec(1, 0, 0),
  });

  assert.equal(store.readNames(created.id)["小 A"], undefined);
  assert.equal(store.readNames(created.id)["小 B"], "王明");
});

test("processSession mode refined still writes speakers when autoDiarize is on", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-post-refined-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  tinyWav(join(store.sessionDir(created.id), "mic.wav"));
  tinyWav(join(store.sessionDir(created.id), "system.wav"));
  await processSession({
    apiKey: "sk-test",
    store,
    sessionId: created.id,
    mode: "refined",
    transcribe: async ({ filePath, diarize }) => {
      if (filePath.endsWith("system.wav")) assert.equal(diarize, true);
      return [{ tStartMs: 0, text: "你好", speakerId: 0 }];
    },
  });
  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.status, "done");
  assert.equal(doc.jobs.speakers.status, "done");
  assert.equal(doc.jobs.speakers.current, "speakers-v1.json");
});
