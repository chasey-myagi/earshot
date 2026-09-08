import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { embedViaChild } from './embed-run.ts';

const workerPath=fileURLToPath(new URL('./worker.ts',import.meta.url));
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
for (const failure of ['exit','send','abort']) test(`voice worker ${failure} settles before any timeout and releases the child`, async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const child=new EventEmitter(),signal=new AbortController();let killed=0,result;
  child.pid=1;child.kill=()=>{killed++;};
  child.postMessage=()=>{
    if(failure==='exit')child.emit('exit',1);
    if(failure==='send')throw Error('IPC unavailable');
    if(failure==='abort')signal.abort();
  };
  const work=embedViaChild(new Float32Array(32000),'fixture-model',{fork:()=>child,workerPath,signal:signal.signal})
    .then(()=>{result='unexpected success';},error=>{result=error.message;});
  await flush();
  assert.equal(result,failure==='exit'?'voiceprint worker exited':failure==='send'?'voiceprint worker send failed':'voiceprint canceled');
  assert.equal(killed,1);
  t.mock.timers.tick(60000);await work;assert.equal(killed,1);
});

test('a silent worker times out at the bound and a successful worker is cleaned up',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const child=new EventEmitter();child.pid=1;let killed=0,result;
  child.kill=()=>{killed++;};child.postMessage=()=>{};
  const work=embedViaChild(new Float32Array(32000),'fixture-model',{fork:()=>child,workerPath}).catch(error=>{result=error.message;});
  t.mock.timers.tick(59999);await flush();assert.equal(result,undefined);assert.equal(killed,0);
  t.mock.timers.tick(1);await work;assert.equal(result,'voiceprint worker timeout');assert.equal(killed,1);
  const success=new EventEmitter();success.pid=2;let successKilled=0;success.kill=()=>successKilled++;
  success.postMessage=()=>success.emit('message',{ok:true,embedding:[1,0]});
  assert.deepEqual(Array.from(await embedViaChild(new Float32Array(32000),'fixture-model',{fork:()=>success,workerPath})),[1,0]);
  assert.equal(successKilled,1);t.mock.timers.tick(60000);assert.equal(successKilled,1);
});
