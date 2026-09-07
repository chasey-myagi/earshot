import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createSessionStore } from "../store/sessions.ts";
import { hasAnyVoiceprint, readVoiceBook } from "./book.ts";
import { enrollSpeaker } from "./enroll.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

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

test("enrollSpeaker stores a voiceprint after a cluster is named", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-enroll-"));
  const store = createSessionStore(root);
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
  store.renameSpeaker({ sessionId: created.id, from: "小 A", to: "王明" });
  await enrollSpeaker({
    store,
    sessionId: created.id,
    from: "小 A",
    to: "王明",
    embed: async () => new Float32Array([0.5, -0.25, 0.125]),
  });
  const book = readVoiceBook(root);
  assert.equal(book[0].name, "王明");
  assert.deepEqual(Array.from(book[0].embeddings[0]), [0.5, -0.25, 0.125]);
});

test("enrollSpeaker does not record a voiceprint without cluster audio", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-enroll-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  await enrollSpeaker({
    store,
    sessionId: created.id,
    from: "小 A",
    to: "王明",
    embed: async () => new Float32Array([1]),
  });
  assert.equal(hasAnyVoiceprint(root), false);
});

test("enrollSpeaker does not write when renaming to 你 or a blank name", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-enroll-"));
  const store = createSessionStore(root);
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
  await enrollSpeaker({
    store,
    sessionId: created.id,
    from: "小 A",
    to: "你",
    embed: async () => new Float32Array([1]),
  });
  await enrollSpeaker({
    store,
    sessionId: created.id,
    from: "小 A",
    to: "   ",
    embed: async () => new Float32Array([1]),
  });
  assert.equal(hasAnyVoiceprint(root), false);
});

test("enrollSpeaker finds the cluster after a second rename updates names", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-enroll-"));
  const store = createSessionStore(root);
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
  store.renameSpeaker({ sessionId: created.id, from: "小 A", to: "王明" });
  store.renameSpeaker({ sessionId: created.id, from: "王明", to: "李雷" });
  await enrollSpeaker({
    store,
    sessionId: created.id,
    from: "王明",
    to: "李雷",
    embed: async () => new Float32Array([0.25, 0.5, 0.75]),
  });
  const book = readVoiceBook(root);
  assert.equal(book[0].name, "李雷");
  assert.deepEqual(Array.from(book[0].embeddings[0]), [0.25, 0.5, 0.75]);
});

test("enrollSpeaker does not write when speakers file is empty or illegal", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-enroll-"));
  const store = createSessionStore(root);
  const empty = store.createRecording();
  store.finalize(empty.id, "complete");
  store.patchJobs(empty.id, { speakers: { status: "done", current: "speakers-v1.json" } });
  writeToneWav(join(store.sessionDir(empty.id), "system.wav"), 8);
  writeFileSync(join(store.sessionDir(empty.id), "speakers-v1.json"), JSON.stringify({ turns: [] }));
  await enrollSpeaker({
    store,
    sessionId: empty.id,
    from: "小 A",
    to: "王明",
    embed: async () => new Float32Array([1]),
  });
  assert.equal(hasAnyVoiceprint(root), false);

  const bad = store.createRecording();
  store.finalize(bad.id, "complete");
  store.patchJobs(bad.id, { speakers: { status: "done", current: "speakers-v1.json" } });
  writeToneWav(join(store.sessionDir(bad.id), "system.wav"), 8);
  writeFileSync(join(store.sessionDir(bad.id), "speakers-v1.json"), "not-json");
  await enrollSpeaker({
    store,
    sessionId: bad.id,
    from: "小 A",
    to: "王明",
    embed: async () => new Float32Array([1]),
  });
  assert.equal(hasAnyVoiceprint(root), false);
});

test("enrollSpeaker stays silent when embed is empty or throws", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-enroll-"));
  const store = createSessionStore(root);
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
  await enrollSpeaker({
    store,
    sessionId: created.id,
    from: "小 A",
    to: "王明",
    embed: async () => new Float32Array(),
  });
  assert.equal(hasAnyVoiceprint(root), false);
  await enrollSpeaker({
    store,
    sessionId: created.id,
    from: "小 A",
    to: "王明",
    embed: async () => {
      throw new Error("embed boom");
    },
  });
  assert.equal(hasAnyVoiceprint(root), false);
});


for (const change of ['none','operation','name','speakers','refined']) {
  test(`delayed embedding commits only while its naming operation and artifacts remain current: ${change}`, async () => {
    root = mkdtempSync(join(tmpdir(), 'earshot-enroll-delayed-'));
    const store=createSessionStore(root), doc=store.createRecording();
    store.finalize(doc.id,'complete');
    store.patchJobs(doc.id,{speakers:{status:'done',current:'speakers-v1.json'}});
    const dir=store.sessionDir(doc.id); writeToneWav(join(dir,'system.wav'),8);
    writeFileSync(join(dir,'speakers-v1.json'),JSON.stringify({clusters:[{speaker:'小 A',segments:[{startMs:0,endMs:8000}]}]}));
    store.writeNames(doc.id,{'小 A':'王明'});
    let current=true;
    const entered=Promise.withResolvers(), result=Promise.withResolvers();
    const registration=enrollSpeaker({store,sessionId:doc.id,from:'小 A',to:'王明',isCurrent:()=>current,
      embed:async()=>{entered.resolve();return result.promise;}});
    await entered.promise;
    assert.deepEqual(readVoiceBook(root),[]);
    if(change==='operation')current=false;
    if(change==='name')store.writeNames(doc.id,{'小 A':'李雷'});
    if(change==='speakers')store.patchJobs(doc.id,{speakers:{status:'done',current:'speakers-v2.json'}});
    if(change==='refined')store.patchJobs(doc.id,{refined:{status:'done',current:'refined-v2.json'}});
    result.resolve(new Float32Array([0.5,-0.25,0.125])); await registration;
    const book=readVoiceBook(root);
    if(change==='none'){assert.equal(book.length,1);assert.equal(book[0].name,'王明');assert.deepEqual(Array.from(book[0].embeddings[0]),[0.5,-0.25,0.125]);}
    else assert.deepEqual(book,[],'a late embedding must not leave an obsolete voiceprint');
  });
}
