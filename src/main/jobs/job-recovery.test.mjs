import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { assembleSnapshot } from '../store/snapshot.ts';
import { createSessionStore } from '../store/sessions.ts';
import { createPcmWavWriter } from '../store/wav.ts';
import { processSession } from './post.ts';
import { queuePost, cancelJob, recoverStuckJobs } from './orchestrate.ts';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'earshot-job-recovery-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=createSessionStore(root),doc=store.createRecording();store.finalize(doc.id,'complete');
  for(const track of ['mic','system']) {
    const wav=createPcmWavWriter(join(store.sessionDir(doc.id),track+'.wav'));wav.write(Buffer.alloc(32000));wav.close();
  }
  const old={turns:[{id:'old',track:'other',speaker:'小 A',tStartMs:0,text:'原稿'}]};
  writeFileSync(join(store.sessionDir(doc.id),'refined-v1.json'),JSON.stringify(old));
  store.patchJobs(doc.id,{refined:{status:'done',current:'refined-v1.json'},speakers:{status:'done',current:'speakers-v1.json'}});
  return {root,store,id:doc.id,old};
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}

for(const mode of ['all','speakers']) test(`canceling ${mode} persists intent, ignores late provider success, and can resume`,async t=>{
  const {root,store,id,old}=fixture(t),started=deferred(),provider=deferred(),completed=deferred();
  let identifyCalls=0;
  const queue={store,apiKey:'fixture-only',jobsInFlight:new Set(),jobAbort:new Map(),jobFailReasons:new Map(),
    process:options=>processSession({...options,transcribe:async()=>{started.resolve();return provider.promise;},
      identify:async()=>{identifyCalls++;}}).finally(()=>completed.resolve())};
  assert.equal(queuePost(queue,id,mode).ok,true);await started.promise;
  assert.equal(cancelJob(queue,id).ok,true);
  const during=createSessionStore(root).readSession(id);
  assert.equal(during.jobs.speakers.status,'canceling');
  assert.equal(during.jobs.refined.status,mode==='speakers'?'done':'canceling');
  assert.equal(cancelJob(queue,id).ok,true,'repeated cancel is idempotent');
  provider.resolve([{tStartMs:0,text:'迟到结果',speakerId:0}]);await completed.promise;await Promise.resolve();
  const reopened=createSessionStore(root),after=reopened.readSession(id);
  assert.equal(after.jobs.speakers.status,'canceled');
  assert.equal(after.jobs.refined.status,mode==='speakers'?'done':'canceled');
  assert.equal(after.jobs.refined.current,'refined-v1.json');
  assert.deepEqual(JSON.parse(readFileSync(join(store.sessionDir(id),'refined-v1.json'),'utf8')),old);
  assert.equal(identifyCalls,0,'canceled processing must not begin voice identification');
  assert.equal(reopened.getDetail(id).jobs.speakers,'canceled');
  await processSession({store:reopened,sessionId:id,apiKey:'fixture-only',mode,
    transcribe:async()=>[{tStartMs:0,text:'恢复结果',speakerId:0}],identify:async()=>{}});
  assert.equal(reopened.readSession(id).jobs.speakers.status,'done');
});

test('reopening a canceled-in-flight job makes it canceled without a key or a new provider request',t=>{
  const {root,store,id}=fixture(t);
  store.patchJobs(id,{refined:{status:'canceling'},speakers:{status:'canceling'}});
  const reopened=createSessionStore(root);let requests=0;
  recoverStuckJobs({store:reopened,apiKey:null,jobsInFlight:new Set(),jobAbort:new Map(),jobFailReasons:new Map(),
    process:async()=>{requests++;}});
  assert.equal(reopened.readSession(id).jobs.refined.status,'canceled');
  assert.equal(reopened.readSession(id).jobs.speakers.status,'canceled');
  assert.equal(requests,0);
});

test('speaker-only retry keeps the available refined draft visible and never retranscribes its microphone',async t=>{
  const {store,id}=fixture(t);const states=[],paths=[];
  await processSession({store,sessionId:id,apiKey:'fixture-only',mode:'speakers',
    onChange:()=>states.push(store.getDetail(id).jobs),
    transcribe:async({filePath})=>{paths.push(filePath);return [{tStartMs:0,text:'区分结果',speakerId:0}];},
    identify:async()=>{}});
  assert.equal(states[0].refined,'done');assert.equal(states[0].speakers,'running');
  assert.deepEqual(paths,[join(store.sessionDir(id),'system.wav')]);
  assert.equal(store.readSession(id).jobs.refined.status,'done');
});

test('classified failure survives reopening, and a successful retry clears it',async t=>{
  const {root,store,id}=fixture(t);
  await processSession({store,sessionId:id,apiKey:'fixture-only',mode:'all',
    transcribe:async()=>{throw new Error('fetch failed ECONNREFUSED');},identify:async()=>{}});
  const reopened=createSessionStore(root),jobs=reopened.getDetail(id).jobs;
  assert.equal(jobs.failedReason,'网络不通');assert.equal(jobs.speakersFailReason,'网络不通');
  assert.equal(jobs.refined,'failed');
  await processSession({store:reopened,sessionId:id,apiKey:'fixture-only',mode:'all',
    transcribe:async()=>[],identify:async()=>{}});
  const done=createSessionStore(root).getDetail(id).jobs;
  assert.equal(done.refined,'done');assert.equal(done.failedReason,undefined);assert.equal(done.speakersFailReason,undefined);
});

test('cancel after completion cannot turn a successful result into a canceled one',async t=>{
  const {store,id}=fixture(t);
  await processSession({store,sessionId:id,apiKey:'fixture-only',mode:'all',transcribe:async()=>[],identify:async()=>{}});
  const queue={store,apiKey:'fixture-only',jobsInFlight:new Set(),jobAbort:new Map(),jobFailReasons:new Map()};
  assert.equal(cancelJob(queue,id).ok,false);assert.equal(store.readSession(id).jobs.refined.status,'done');
});

// Provider credentials never enter stored failure reasons, reopened UI state or default logs.

const syntheticCredentialDigits = "01234567890123456789012345678901";
const safeReasons = new Set(["密钥不对", "转写超时", "网络不通", "处理没完成"]);

async function failureThenRetry(t, failureMessage) {
  const root = mkdtempSync(join(tmpdir(), "earshot-safe-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(root);
  const { id } = store.createRecording();
  const audioPath = join(store.sessionDir(id), "system.wav");
  const writer = createPcmWavWriter(audioPath);
  const pcm = Buffer.alloc(32000);
  for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(5000 * Math.sin(i * 0.2)), i * 2);
  writer.write(pcm);
  writer.close();
  store.finalize(id, "complete");
  const originalAudio = readFileSync(audioPath);
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(format(...args)));

  // External service boundary only: provider, processing, persistence and snapshot are real.
  let cloudFailure = failureMessage;
  let submissions = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/uploads") {
      return Response.json({ data: { upload_host: "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/audio", upload_dir: "test-audio",
        policy: "test-policy", signature: "test-signature", oss_access_key_id: "test-id" } });
    }
    if (url.href === "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/audio") {
      await init.body.get("file").arrayBuffer();
      return new Response("");
    }
    if (url.pathname === "/api/v1/services/audio/asr/transcription") {
      submissions++;
      return Response.json({ output: { task_id: "test-task" } });
    }
    if (url.pathname === "/api/v1/tasks/test-task") {
      return Response.json({ output: cloudFailure
        ? { task_status: "FAILED", code: "INTERNAL_ERROR", message: cloudFailure }
        : { task_status: "SUCCEEDED", results: [{ transcription_url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/transcript.json" }] } });
    }
    if (url.href === "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/transcript.json") {
      return Response.json({ transcripts: [{ sentences: [
        { begin_time: 100, end_time: 900, text: "重试结果", speaker_id: 0 },
      ] }] });
    }
    throw new Error(`Unexpected test cloud URL: ${url.href}`);
  });

  await processSession({ store, sessionId: id, apiKey: "sk-test", mode: "all" });
  const sessionText = readFileSync(join(store.sessionDir(id), "session.json"), "utf8");
  const persisted = JSON.parse(sessionText);
  const reopened = createSessionStore(root);
  const runtime = { hasApiKey: true, permissions: { microphone: "granted", screen: "granted" },
    recording: null, playingSessionId: null, selectedId: id };
  const failedSnapshot = assembleSnapshot(reopened, runtime);
  const summaryJobs = failedSnapshot.sessions.find((session) => session.id === id).jobs;
  const selectedJobs = failedSnapshot.selected.jobs;
  assert.deepEqual([
    persisted.jobs.refined.status, persisted.jobs.speakers.status,
    summaryJobs.refined, summaryJobs.speakers, selectedJobs.refined, selectedJobs.speakers,
  ], Array(6).fill("failed"));

  cloudFailure = null;
  await processSession({ store: reopened, sessionId: id, apiKey: "sk-test", mode: "all" });
  assert.equal(submissions, 1, "automatic restoration cannot repeat a failed paid task");
  assert.equal(reopened.readSession(id).jobs.refined.status, "failed");
  await processSession({ store: reopened, sessionId: id, apiKey: "sk-test", mode: "all", retryUncertainSubmission: true });
  assert.equal(submissions, 2, "a deliberate retry submits exactly once");
  const recovered = assembleSnapshot(createSessionStore(root), runtime);
  assert.equal(recovered.selected.jobs.refined, "done");
  assert.equal(recovered.selected.jobs.speakers, "done");
  assert.equal(recovered.selected.jobs.failedReason, undefined);
  assert.equal(recovered.selected.jobs.speakersFailReason, undefined);
  assert.deepEqual(recovered.selected.turns.map((turn) => turn.text), ["重试结果"]);
  assert.deepEqual(readFileSync(audioPath), originalAudio);
  return {
    sessionText,
    failedSnapshot,
    logs: logs.join("\n"),
    persistedReasons: [persisted.jobs.refined.reason, persisted.jobs.speakers.reason],
    snapshotReasons: [summaryJobs.failedReason, summaryJobs.speakersFailReason,
      selectedJobs.failedReason, selectedJobs.speakersFailReason],
  };
}

test("provider credentials cannot enter persisted or reopened failure reasons", async (t) => {
  const result = await failureThenRetry(t, `Rejected credential sk-${syntheticCredentialDigits}`);
  assert.deepEqual({
    persistedReasonsAreSafe: result.persistedReasons.every((reason) => safeReasons.has(reason)),
    snapshotReasonsAreSafe: result.snapshotReasons.every((reason) => safeReasons.has(reason)),
    credentialDigitsPersisted: result.sessionText.includes(syntheticCredentialDigits),
    credentialDigitsInSnapshot: JSON.stringify(result.failedSnapshot).includes(syntheticCredentialDigits),
    credentialInLogs: result.logs.includes(`sk-${syntheticCredentialDigits}`),
    credentialDigitsInLogs: result.logs.includes(syntheticCredentialDigits),
  }, {
    persistedReasonsAreSafe: true, snapshotReasonsAreSafe: true,
    credentialDigitsPersisted: false, credentialDigitsInSnapshot: false,
    credentialInLogs: false, credentialDigitsInLogs: false,
  });
});

test("ordinary timeout errors keep a safe reason and remain retryable after reopening", async (t) => {
  const result = await failureThenRetry(t, "request timed out");
  assert.deepEqual(result.persistedReasons, ["转写超时", "转写超时"]);
  assert.deepEqual(result.snapshotReasons, Array(4).fill("转写超时"));
});
