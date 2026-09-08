import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeSync, ftruncateSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from './store/sessions.ts';
import { createPcmWavWriter, repairWavHeader, sessionDurationSec } from './store/wav.ts';
import { AUDIO_CHUNK_BYTES, audioResponse, openSessionAudio } from './playback-audio.ts';
import { recoverStuckJobs } from './jobs/orchestrate.ts';

const RATE=16_000, HEADER=44;
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'earshot-long-recording-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,store:createSessionStore(root)};
}
// APFS sparse holes read as silence. Long logical durations do not allocate hundreds of MB.
function sparseWav(path,seconds,{unfinalized=false,extraBytes=0}={}){
  const writer=createPcmWavWriter(path);writer.close();
  const fd=openSync(path,'r+');
  try{
    ftruncateSync(fd,HEADER+Math.round(seconds*RATE)*2+extraBytes);
    if(unfinalized){const zero=Buffer.alloc(4);writeSync(fd,zero,0,4,4);writeSync(fd,zero,0,4,40);}
  }finally{closeSync(fd);}
  if(!unfinalized)repairWavHeader(path);
  const info=statSync(path);
  assert.ok(info.blocks*512<2*1024*1024,'test must remain sparse, not physically allocate long recording audio');
}
function header(path){const fd=openSync(path,'r');try{const out=Buffer.alloc(44);assert.equal(readSync(fd,out,0,44,0),44);return out;}finally{closeSync(fd);}}

for(const seconds of [3601,7200.5])test(`crash recovery repairs a sparse ${seconds}s WAV and derives duration from actual audio`,t=>{
  const {root,store}=fixture(t),doc=store.createRecording(),dir=store.sessionDir(doc.id);
  // The persisted wall clock is intentionally unrelated to captured duration.
  store.writeSession({...doc,startedAt:'2001-01-01T00:00:00.000Z'});
  const mic=join(dir,'mic.wav'),system=join(dir,'system.wav');
  sparseWav(mic,seconds,{unfinalized:true});sparseWav(system,seconds-10,{unfinalized:true});
  assert.equal(header(mic).readUInt32LE(40),0);
  const reopened=createSessionStore(root);
  assert.deepEqual(reopened.recoverOrphans(),[doc.id]);
  assert.equal(reopened.readSession(doc.id).durationSec,Math.floor(seconds));
  assert.equal(reopened.readSession(doc.id).status,'incomplete');
  for(const path of [mic,system]){
    const wav=header(path),size=statSync(path).size;
    assert.equal(wav.readUInt32LE(4),size-8);assert.equal(wav.readUInt32LE(40),size-HEADER);
  }
  assert.equal(openSessionAudio(dir).durationSec,seconds);
  assert.deepEqual(createSessionStore(root).recoverOrphans(),[],'second restart must not finalize or rewrite an already recovered session');
});

test('two-hour mixed playback seeks near both track EOFs with bounded reads and preserves exact duration',async t=>{
  const {store}=fixture(t),doc=store.createRecording(),dir=store.sessionDir(doc.id);
  sparseWav(join(dir,'mic.wav'),7200.5);sparseWav(join(dir,'system.wav'),7190.25);
  const audio=openSessionAudio(dir),reader=audio.openReader();t.after(()=>reader.close());
  assert.equal(audio.durationSec,7200.5);assert.equal(audio.warning,undefined);
  for(const second of [0,3600,7190.25,7199.5]){
    const offset=HEADER+Math.floor(second*RATE)*2;
    const out=reader.read(offset,Math.min(AUDIO_CHUNK_BYTES,audio.byteLength-offset));
    assert.ok(out.every(byte=>byte===0));assert.ok(out.length<=AUDIO_CHUNK_BYTES);
  }
  assert.deepEqual(reader.read(audio.byteLength-3,3),Buffer.alloc(3),'odd byte range at EOF must still yield exact requested bytes');
  assert.throws(()=>reader.read(HEADER,AUDIO_CHUNK_BYTES+1),/无效/);
  assert.throws(()=>reader.read(audio.byteLength,1),/无效/);
  const response=audioResponse(new Request('https://fixture.invalid/audio',{headers:{Range:'bytes=-17'}}),audio);
  assert.equal(response.status,206);assert.equal(response.headers.get('content-length'),'17');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.alloc(17));
});

test('late source truncation is reported instead of returning fake silence for recorded long-track bytes',t=>{
  const {store}=fixture(t),doc=store.createRecording(),dir=store.sessionDir(doc.id),mic=join(dir,'mic.wav');
  sparseWav(mic,3601);sparseWav(join(dir,'system.wav'),3601);
  const audio=openSessionAudio(dir),reader=audio.openReader();t.after(()=>reader.close());
  const fd=openSync(mic,'r+');try{ftruncateSync(fd,HEADER+32000);}finally{closeSync(fd);}
  assert.throws(()=>reader.read(HEADER+3600*32000,64),/音轨在读取时发生变化/);
});

test('a crash-truncated partial sample in one long track cannot hide the complete surviving track',t=>{
  const {root,store}=fixture(t),doc=store.createRecording(),dir=store.sessionDir(doc.id);
  sparseWav(join(dir,'mic.wav'),3601,{unfinalized:true,extraBytes:1});
  sparseWav(join(dir,'system.wav'),3600,{unfinalized:true});
  const reopened=createSessionStore(root);reopened.recoverOrphans();
  assert.equal(sessionDurationSec(dir,0),3601);
  const audio=openSessionAudio(dir);assert.equal(audio.durationSec,3600);assert.match(audio.warning,/只有一路/);
  assert.equal(statSync(join(dir,'mic.wav')).size,HEADER+3601*32000+1,'crash evidence must not be silently truncated');
});

test('long live transcript recovery keeps hour-scale timestamps and all complete records before an interrupted tail',t=>{
  const {root,store}=fixture(t),doc=store.createRecording(),dir=store.sessionDir(doc.id);
  sparseWav(join(dir,'mic.wav'),7201,{unfinalized:true});
  const turns=Array.from({length:2401},(_,index)=>({id:`long-${index}`,track:index%2?'other':'you',speaker:index%2?'对方':'你',tStartMs:index*3000,text:`静音测试记录 ${index}`}));
  writeFileSync(join(dir,'live.jsonl'),turns.map(turn=>JSON.stringify(turn)).join('\n')+'\n{"id":"interrupted');
  const reopened=createSessionStore(root);reopened.recoverOrphans();
  const recovered=reopened.getDetail(doc.id);
  assert.equal(recovered.turns.length,turns.length);assert.equal(recovered.turns.at(-1).tStartMs,7_200_000);
  assert.equal(recovered.turns.at(-1).text,turns.at(-1).text);
  assert.equal(recovered.durationSec,7201);
});

test('restart restores long-recording processing with at most two active jobs and no duplicate starts',async t=>{
  const {root,store}=fixture(t),ids=[];
  for(let i=0;i<3;i++){
    const doc=store.createRecording();ids.push(doc.id);
    sparseWav(join(store.sessionDir(doc.id),'mic.wav'),3601+i);
    store.finalize(doc.id,'incomplete',{durationSec:3601+i});
    store.patchJobs(doc.id,{refined:{status:'running',reason:'等待处理'},speakers:{status:'running',reason:'等待处理'}});
  }
  const reopened=createSessionStore(root),started=[],releases=[];
  let active=0,maxActive=0;
  const queue={store:reopened,apiKey:'synthetic-no-network',jobsInFlight:new Set(),jobAbort:new Map(),jobFailReasons:new Map(),pending:new Map(),
    process:async({sessionId})=>{
      started.push(sessionId);active++;maxActive=Math.max(maxActive,active);
      await new Promise(resolve=>releases.push(resolve));
      reopened.patchJobs(sessionId,{refined:{status:'done',reason:null},speakers:{status:'done',reason:null}});active--;
    }};
  recoverStuckJobs(queue);recoverStuckJobs(queue);
  assert.equal(started.length,2);assert.equal(queue.jobsInFlight.size,3);
  const pending=[...queue.pending.values()];
  releases.shift()();
  for(let i=0;i<10&&started.length<3;i++)await Promise.resolve();
  assert.equal(started.length,3);assert.equal(maxActive,2);
  while(releases.length)releases.shift()();await Promise.all(pending);
  assert.equal(new Set(started).size,3);assert.equal(queue.jobsInFlight.size,0);
  assert.deepEqual(ids.map(id=>createSessionStore(root).readSession(id).jobs.refined.status),['done','done','done']);
  for(let i=0;i<ids.length;i++)assert.equal(openSessionAudio(store.sessionDir(ids[i])).durationSec,3601+i);
});
