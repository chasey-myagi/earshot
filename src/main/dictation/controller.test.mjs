import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDictationController } from './controller.ts';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise,resolve}; };
const tick = () => new Promise(r => setImmediate(r));

function fixture(t, extra = {}) {
  let input, stops = 0, released = 0, recordings = 0;
  const inserts = [], submissions = [], states = [];
  const controller = createDictationController({ preflight: () => null, preview: () => false,
    target: () => ({insert: text => {inserts.push(text);return {kind:'verified'};},release: () => released++}),
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

test('preview retains text for copy and never offers an implicit return to the old input', async t => {
  let valid=true, inserted=0;
  const h=fixture(t,{preview:()=>true,target:()=>({insert:()=>{if(!valid)return {kind:'not-posted',reason:'changed'};inserted++;return {kind:'verified'};},release(){}})});
  await h.controller.begin();h.pcm();await h.controller.end();assert.equal(inserted,0);assert.equal(h.controller.snapshot().phase,'result');
  valid=false;assert.equal((await h.controller.insert()).ok,false);assert.equal(inserted,0);assert.equal(h.controller.snapshot().text,'你好。');
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

test('cancel waits for an in-flight paste restoration before allowing shutdown', async t => {
  const cleanup=deferred(); let aborted=false;
  const h=fixture(t,{target:()=>({insert:async(text,signal)=>{signal.addEventListener('abort',()=>{aborted=true;});await cleanup.promise;return{kind:'posted-unconfirmed'};},release(){}})});
  await h.controller.begin();h.pcm();const end=h.controller.end();await tick();
  let done=false;const cancel=h.controller.cancel().then(()=>{done=true;});await tick();
  assert.equal(aborted,true);assert.equal(done,false);assert.equal(h.controller.snapshot().phase,'idle');assert.equal(h.controller.busy(),true);
  cleanup.resolve();await Promise.all([end,cancel]);assert.equal(done,true);assert.equal(h.controller.busy(),false);
});
for (const result of [{kind:'not-posted',reason:'目标变化'}, {kind:'posted-unconfirmed'}]) {
  test(`clipboard restoration warning survives ${result.kind}`,async t=>{
    const h=fixture(t,{target:()=>({insert:()=>({...result,warning:'原剪贴板未能恢复'}),release(){}})});
    await h.controller.begin();h.pcm();await h.controller.end();
    assert.match(h.controller.snapshot().message,/原剪贴板未能恢复/);
    assert.equal(h.controller.snapshot().resultKind,result.kind==='not-posted'?'delivery-failed':'delivery-unconfirmed');
    assert.equal(h.controller.snapshot().text,'你好。');
  });
}

test('user cancel after a possible paste retains the same-session outcome and cleanup warning', async t => {
  const cleanup=deferred();
  const h=fixture(t,{target:()=>({insert:()=>cleanup.promise,release(){}})});
  await h.controller.begin();h.pcm();const end=h.controller.end();await tick();
  const canceled=h.controller.cancel(true);cleanup.resolve({kind:'posted-unconfirmed',warning:'原剪贴板未能恢复'});
  await Promise.all([end,canceled]);
  assert.equal(h.controller.snapshot().phase,'result');assert.equal(h.controller.snapshot().resultKind,'delivery-canceled');
  assert.equal(h.controller.snapshot().text,'你好。');assert.match(h.controller.snapshot().message,/请检查输入框.*原剪贴板未能恢复/);
  assert.equal((await h.controller.insert()).ok,false);
});
test('silent shutdown suppresses a pending user-cancel outcome without losing its cleanup wait', async t => {
  const cleanup=deferred();
  const h=fixture(t,{target:()=>({insert:()=>cleanup.promise,release(){}})});
  await h.controller.begin();h.pcm();const end=h.controller.end();await tick();
  const canceled=h.controller.cancel(true);const shutdown=h.controller.cancel();
  cleanup.resolve({kind:'posted-unconfirmed'});await Promise.all([end,canceled,shutdown]);
  assert.equal(h.controller.snapshot().phase,'idle');
});
test('cancel before a paste was dispatched hides normally, but retains a restoration failure', async t => {
  for(const warning of [undefined,'原剪贴板未能恢复']) {
    const cleanup=deferred();const h=fixture(t,{target:()=>({insert:()=>cleanup.promise,release(){}})});
    await h.controller.begin();h.pcm();const end=h.controller.end();await tick();
    const canceled=h.controller.cancel(true);cleanup.resolve({kind:'not-posted',reason:'已取消',warning});await Promise.all([end,canceled]);
    assert.equal(h.controller.snapshot().phase,warning?'result':'idle');if(warning)assert.match(h.controller.snapshot().message,/原剪贴板未能恢复/);
  }
});
