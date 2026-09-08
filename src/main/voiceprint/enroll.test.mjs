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
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(2000 * Math.sin(i / 20)), 44 + i * 2);
  writeFileSync(path, buf);
}

test('a named cloud cluster containing inconsistent voices is not learned', async () => {
  root=mkdtempSync(join(tmpdir(),'earshot-mixed-enroll-'));const store=createSessionStore(root),doc=store.createRecording();store.finalize(doc.id,'complete');
  store.patchJobs(doc.id,{speakers:{status:'done',current:'speakers-v1.json'}});const dir=store.sessionDir(doc.id);writeToneWav(join(dir,'system.wav'),8);
  writeFileSync(join(dir,'speakers-v1.json'),JSON.stringify({clusters:[{speaker:'小 A',segments:[{startMs:0,endMs:8000}]}]}));
  store.writeNames(doc.id,{'小 A':'张三'});let sample=0;
  await enrollSpeaker({store,sessionId:doc.id,from:'小 A',to:'张三',embed:async()=>new Float32Array(sample++===0?[1,0]:[0,1])});
  assert.equal(hasAnyVoiceprint(root),false);
});

test('shared microphone speakers enroll from microphone audio and can be recognized in a later meeting', async () => {
  const {identifySession}=await import('./identify.ts');
  root=mkdtempSync(join(tmpdir(),'earshot-mic-person-'));const store=createSessionStore(root);
  function meeting(){const doc=store.createRecording();store.finalize(doc.id,'complete');store.patchJobs(doc.id,{speakers:{status:'done',current:'speakers-v1.json'}});
    const dir=store.sessionDir(doc.id);writeToneWav(join(dir,'mic.wav'),8);
    writeFileSync(join(dir,'speakers-v1.json'),JSON.stringify({clusters:[{speaker:'现场 A',track:'you',segments:[{startMs:0,endMs:8000}]}]}));return doc.id;}
  const first=meeting();store.writeNames(first,{'现场 A':'张三'});
  assert.equal(await enrollSpeaker({store,sessionId:first,from:'现场 A',to:'张三',embed:async()=>new Float32Array([1,0])}),'remembered');
  const second=meeting();await identifySession({store,sessionId:second,embed:async()=>new Float32Array([1,0])});
  assert.equal(store.readNames(second)['现场 A'],'张三');
});

test('a confirmed correction retires wrong templates even when new embedding is unavailable', async () => {
  root=mkdtempSync(join(tmpdir(),'earshot-retire-wrong-'));const store=createSessionStore(root),doc=store.createRecording();store.finalize(doc.id,'complete');
  store.patchJobs(doc.id,{speakers:{status:'done',current:'speakers-v1.json'}});const dir=store.sessionDir(doc.id);writeToneWav(join(dir,'system.wav'),8);
  writeFileSync(join(dir,'speakers-v1.json'),JSON.stringify({clusters:[{speaker:'小 A',segments:[{startMs:0,endMs:8000}]}]}));
  store.writeNames(doc.id,{'小 A':'错名'});await enrollSpeaker({store,sessionId:doc.id,from:'小 A',to:'错名',embed:async()=>new Float32Array([1,0])});
  store.writeNames(doc.id,{'小 A':'正确姓名'});await enrollSpeaker({store,sessionId:doc.id,from:'小 A',to:'正确姓名',embed:async()=>null});
  assert.deepEqual(readVoiceBook(root),[]);
});

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

test("enrollSpeaker reports unavailable when an eligible named speaker embedding is empty or throws", async () => {
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
  store.writeNames(created.id, { "小 A": "王明" });
  let calls = 0;
  const empty = await enrollSpeaker({
    store,
    sessionId: created.id,
    from: "小 A",
    to: "王明",
    embed: async () => { calls++; return new Float32Array(); },
  });
  assert.equal(empty, "unavailable");
  assert.equal(calls, 1);
  assert.equal(hasAnyVoiceprint(root), false);
  const thrown = await enrollSpeaker({
    store,
    sessionId: created.id,
    from: "小 A",
    to: "王明",
    embed: async () => {
      calls++;
      throw new Error("embed boom");
    },
  });
  assert.equal(thrown, "unavailable");
  assert.equal(calls, 2);
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

test('correcting a name after a cached transcript retry retires the old artifact voice source', async () => {
  const {processSession}=await import('../jobs/post.ts');
  root=mkdtempSync(join(tmpdir(),'earshot-retry-correction-'));
  const store=createSessionStore(root),doc=store.createRecording();store.finalize(doc.id,'complete');
  writeToneWav(join(store.sessionDir(doc.id),'system.wav'),8);
  const transcribe=async()=>[{tStartMs:0,tEndMs:8000,text:'同一段声音',speakerId:0}];
  const embed=async()=>new Float32Array([1,0]);
  await processSession({apiKey:'fixture-only',store,sessionId:doc.id,mode:'all',transcribe,embed});
  store.renameSpeaker({sessionId:doc.id,from:'小 A',to:'错名'});
  await enrollSpeaker({store,sessionId:doc.id,from:'小 A',to:'错名',embed});
  await processSession({apiKey:'fixture-only',store,sessionId:doc.id,mode:'all',transcribe,embed});
  store.renameSpeaker({sessionId:doc.id,from:'错名',to:'正确姓名'});
  assert.equal(await enrollSpeaker({store,sessionId:doc.id,from:'小 A',to:'正确姓名',embed}),'remembered');
  assert.deepEqual(readVoiceBook(root).map(person=>person.name),['正确姓名']);
});

test('incomplete new grouping never enrolls a new name from old cluster audio', async () => {
  const {processSession}=await import('../jobs/post.ts');
  root=mkdtempSync(join(tmpdir(),'earshot-incomplete-group-'));
  const store=createSessionStore(root),doc=store.createRecording();store.finalize(doc.id,'complete');
  writeToneWav(join(store.sessionDir(doc.id),'system.wav'),16);
  const run=transcribe=>processSession({apiKey:'fixture-only',store,sessionId:doc.id,mode:'all',transcribe});
  await run(async()=>[{tStartMs:0,tEndMs:8000,text:'甲',speakerId:0},{tStartMs:8000,tEndMs:16000,text:'乙',speakerId:1}]);
  await run(async()=>[{tStartMs:0,tEndMs:8000,text:'甲'},{tStartMs:8000,tEndMs:16000,text:'乙',speakerId:0}]);
  store.renameSpeaker({sessionId:doc.id,from:'小 A',to:'乙'});
  let called=0;await enrollSpeaker({store,sessionId:doc.id,from:'小 A',to:'乙',embed:async()=>{called++;return new Float32Array([1,0]);}});
  assert.equal(called,0);assert.equal(hasAnyVoiceprint(root),false);
  assert.equal(store.readSession(doc.id).jobs.speakers.current,null);
});

for(const seconds of [4,5.999,6]) test(`evidence eligibility at ${seconds} seconds is shared by enrollment and identification`,async()=>{
  const {identifySession}=await import('./identify.ts');const {addVoiceprint}=await import('./book.ts');
  root=mkdtempSync(join(tmpdir(),'earshot-duration-evidence-'));const store=createSessionStore(root),doc=store.createRecording();store.finalize(doc.id,'complete');
  const dir=store.sessionDir(doc.id);writeToneWav(join(dir,'system.wav'),8);
  store.patchJobs(doc.id,{speakers:{status:'done',current:'speakers-v1.json'}});
  writeFileSync(join(dir,'speakers-v1.json'),JSON.stringify({clusters:[{speaker:'小 A',segments:[{startMs:0,endMs:seconds*1000}]}]}));
  addVoiceprint(root,'参考人物',new Float32Array([1,0]));let calls=0;
  const embed=async()=>{calls++;return new Float32Array([1,0]);};
  await identifySession({store,sessionId:doc.id,embed});
  assert.equal(store.readNames(doc.id)['小 A'],seconds===6?'参考人物':undefined);
  store.writeNames(doc.id,{'小 A':'新人物'});
  const result=await enrollSpeaker({store,sessionId:doc.id,from:'小 A',to:'新人物',embed});
  assert.equal(result,seconds===6?'remembered':'insufficient');assert.equal(calls,seconds===6?4:0);
});
