import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDictationController } from './controller.ts';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise,resolve}; };
const tick = () => new Promise(r => setImmediate(r));

function fixture(t, extra = {}) {
  let input, stops = 0, released = 0, recordings = 0;
  const inserts = [], submissions = [], states = [];
  const controller = createDictationController({ preflight: () => null, preview: () => false,
    target: () => ({insert: text => {inserts.push(text);return true;},release: () => released++}),
    capture: async value => { input = value; recordings++; return {stop: async () => {stops++;}}; },
    transcribe: async (pcm, signal) => { submissions.push(Buffer.from(pcm)); return '你好。'; },
    changed: state => states.push(state), ...extra });
  t.after(() => controller.cancel());
  return {controller,inserts,submissions,states,pcm: () => input.pcm(Buffer.alloc(16000,2)),stops:()=>stops,released:()=>released,recordings:()=>recordings};
}

test('hold starts microphone once, release stops before recognition, inserts once and releases target', async t => {
  const h = fixture(t); await h.controller.begin();
  assert.equal(h.controller.snapshot().phase,'listening');
  assert.equal((await h.controller.begin()).ok,false);
  h.pcm(); await Promise.all([h.controller.end(),h.controller.end()]);
  assert.equal(h.stops(),1); assert.equal(h.submissions.length,1); assert.deepEqual(h.inserts,['你好。']); assert.equal(h.released(),1);
  assert.equal(h.controller.snapshot().phase,'success');
});

test('immediate release or cancellation during delayed microphone startup cannot leave a recording behind', async t => {
  let stop = 0; const opened = deferred();
  const h = fixture(t,{capture: async () => {await opened.promise;return{stop:async()=>stop++};}});
  const begin = h.controller.begin(); await tick();
  assert.equal(h.controller.snapshot().phase,'preparing');
  const end = h.controller.end();
  assert.equal(h.controller.busy(),true);
  assert.equal((await h.controller.begin()).ok,false);
  opened.resolve(); await Promise.all([begin,end]);
  assert.equal(stop,1); assert.equal(h.controller.snapshot().phase,'idle'); assert.equal(h.inserts.length,0);
  const early = h.controller.begin(); const cancel = h.controller.cancel(); await Promise.all([early,cancel]);
  assert.equal(h.controller.snapshot().phase,'idle');
});

test('two begin requests in the same tick allocate only one microphone', async t => {
  const h=fixture(t); const results=await Promise.all([h.controller.begin(),h.controller.begin()]);
  assert.equal(results.filter(r=>r.ok).length,1); assert.equal(h.recordings(),1);
});

test('Esc during recognition discards a late successful provider response', async t => {
  const response=deferred(); const h=fixture(t,{transcribe:()=>response.promise});
  await h.controller.begin(); h.pcm(); const ending=h.controller.end(); await tick();
  assert.equal(h.controller.snapshot().phase,'transcribing');
  await h.controller.cancel(); response.resolve('迟到文字'); await ending;
  assert.equal(h.controller.snapshot().phase,'idle'); assert.deepEqual(h.inserts,[]);
});

test('service failure retains audio for one retry; successful retry releases it and cannot reinsert', async t => {
  let calls=0; const audio=[];
  const h=fixture(t,{transcribe:async pcm=>{audio.push(Buffer.from(pcm));if(++calls===1)throw Error('网络失败');return '恢复后的文字';}});
  await h.controller.begin();h.pcm();await h.controller.end();
  assert.equal(h.controller.snapshot().retryable,true);assert.deepEqual(h.inserts,[]);
  await h.controller.retry();assert.deepEqual(audio[0],audio[1]);assert.deepEqual(h.inserts,['恢复后的文字']);
  assert.equal((await h.controller.retry()).ok,false);
});

test('preview inserts only on request; changed input target keeps text for copy', async t => {
  let valid=true, inserted=0;
  const h=fixture(t,{preview:()=>true,target:()=>({insert:()=>{if(!valid)return false;inserted++;return true;},release(){}})});
  await h.controller.begin();h.pcm();await h.controller.end();assert.equal(inserted,0);assert.equal(h.controller.snapshot().phase,'result');
  valid=false;assert.equal(h.controller.insert().ok,false);assert.equal(inserted,0);assert.equal(h.controller.snapshot().text,'你好。');
});

test('meeting or microphone preflight failure never captures; empty/short audio never inserts', async t => {
  const blocked=fixture(t,{preflight:()=> '会议正在录制'});assert.equal((await blocked.controller.begin()).ok,false);assert.equal(blocked.recordings(),0);
  const short=fixture(t);await short.controller.begin();await short.controller.end();assert.equal(short.submissions.length,0);assert.equal(short.inserts.length,0);
  const silent=fixture(t,{transcribe:async()=>''});await silent.controller.begin();silent.pcm();await silent.controller.end();assert.match(silent.controller.snapshot().message,/没有听清/);assert.equal(silent.controller.snapshot().retryable,false);
});

test('maximum utterance duration releases the microphone and submits once', async t => {
  const h=fixture(t,{maxMs:250});await h.controller.begin();h.pcm();await tick();
  assert.equal(h.stops(),1);assert.equal(h.submissions.length,1);assert.equal(h.submissions[0].length,8000);assert.equal(h.inserts.length,1);
});

test('stream receives audio before release, completed history precedes insertion and cancellation blocks late polish', async t => {
 const events=[], result=deferred();
 const h=fixture(t,{stream:()=>({send:bytes=>events.push(['pcm',bytes.length]),finish:async()=>{events.push(['finish']);return '原始稿';}}),
  complete:async(text,input)=>{events.push(['saved',text,input.durationSec]);return result.promise;}});
 await h.controller.begin();h.pcm();assert.deepEqual(events,[['pcm',16000]]);
 const end=h.controller.end();await tick();assert.deepEqual(events,[['pcm',16000],['finish'],['saved','原始稿',0.5]]);assert.deepEqual(h.inserts,[]);
 await h.controller.cancel();result.resolve('整理稿');await end;assert.deepEqual(h.inserts,[]);assert.equal(h.controller.snapshot().phase,'idle');
});
