import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {sourceLoader} from '../../../scripts/test-source-loader.mjs';

// Exercise the real lease, delivery and controller together, without a system clipboard.
test('cancel during temporary claim preserves a real rollback failure through delivery and HUD state', async () => {
  const load=sourceLoader(resolve('src/main/dictation/clipboard.ts'),{});
  const {createClipboardLease}=load('./clipboard'),{createPasteTarget}=load('./input-target'),{createDictationController}=load('./controller');
  let version=1,items=[[{type:'public.utf8-plain-text',data:Buffer.from('original')}]],writes=0,cancellation;
  const clone=x=>x.map(item=>item.map(entry=>({...entry,data:Buffer.from(entry.data)})));
  const port={snapshot:()=>({changeCount:version,items:clone(items)}),changeCount:()=>version,
    owns:(v,id)=>v===version&&items.some(item=>item.some(entry=>entry.type==='app.earshot.dictation-session'&&entry.data.toString()===id)),
    replace(next,expected){assert.equal(expected,version);writes++;
      if(writes===2)throw Error('synthetic restore failed');
      items=clone(next);version++;if(writes===1)cancellation=controller.cancel(true);return version;}};
  const lease=createClipboardLease(port);
  const clipboard={claim:async(text,signal)=>{await Promise.resolve();return lease.claim(text,()=>signal.aborted);},owned:async id=>lease.owned(id),finish:async id=>lease.finish(id)};
  const target=createPasteTarget({prepare(){},read:()=>({sameContext:true,secure:false,keysReleased:true,editable:null}),paste(){throw Error('Must not paste after cancel');},release(){}},clipboard);
  const controller=createDictationController({preflight:()=>null,preview:()=>false,target:()=>target,changed(){},
    capture:async({pcm})=>{pcm(Buffer.alloc(16000));return{stop:async()=>{}};},transcribe:async()=> 'recognized'});
  try {
    await controller.begin();await controller.end();await cancellation;
    assert.equal(writes,2);assert.equal(controller.snapshot().phase,'result');assert.equal(controller.snapshot().text,'recognized');
    assert.match(controller.snapshot().message,/原剪贴板未能恢复/);
    assert.equal(lease.finish(),'restored');assert.equal(items[0][0].data.toString(),'original');
  }finally{await controller.cancel();lease.finish();}
});

for (const failure of ['timeout', 'worker-exit']) for (const notify of [true, false]) test(`cancel ${notify ? 'reports' : 'silences'} unresolved clipboard ${failure} and ignores late replies in a new session`, async t => {
  const {EventEmitter}=await import('node:events');t.mock.timers.enable({apis:['setTimeout']});let worker,request;
  class Worker extends EventEmitter {constructor(){super();worker=this;}unref(){}postMessage(value){request=value;}}
  const load=sourceLoader(resolve('src/main/dictation/pasteboard-client.ts'),{'node:worker_threads':{Worker}});
  const clipboard=load('./pasteboard-client').createPasteboardClient();
  const target=load('./input-target').createPasteTarget({prepare(){},read:()=>({sameContext:true,secure:false,keysReleased:true,editable:null}),paste(){throw Error('No paste after cancellation');},release(){}},clipboard);
  const controller=load('./controller').createDictationController({preflight:()=>null,preview:()=>false,target:()=>target,changed(){},
    capture:async({pcm})=>{pcm(Buffer.alloc(16000));return{stop:async()=>{}};},transcribe:async()=> 'recognized'});
  try {
    await controller.begin();const end=controller.end();await new Promise(resolve=>setImmediate(resolve));
    const canceled=controller.cancel(notify);if(failure==='timeout')t.mock.timers.tick(2000);else worker.emit('exit',1);await Promise.all([end,canceled]);
    if(notify){assert.equal(controller.snapshot().phase,'result');assert.equal(controller.snapshot().text,'recognized');assert.match(controller.snapshot().message,/剪贴板收尾尚未确认/);}
    else assert.equal(controller.snapshot().phase,'idle');
    await controller.begin();const fresh=controller.snapshot();assert.equal(fresh.phase,'listening');
    worker.emit('message',{id:request.id,ok:false,error:'rollback failed',warning:'原剪贴板未能恢复'});
    assert.deepEqual(controller.snapshot(),fresh);
  }finally{await controller.cancel();}
});
