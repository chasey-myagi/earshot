import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {resolve} from 'node:path';
import {sourceLoader} from '../../../scripts/test-source-loader.mjs';

test('worker protocol distinguishes a claim rollback failure from ordinary cancellation', () => {
  const native=sourceLoader(resolve('src/main/dictation/macos-pasteboard.ts'),{})('./macos-pasteboard');
  const messages=[],flag=new Int32Array(new SharedArrayBuffer(4));let version=1,writes=0,items=[],closed=false;
  const parentPort=Object.assign(new EventEmitter(),{postMessage:message=>messages.push(message),close(){}});
  const board={snapshot:()=>({changeCount:version,items:[[{type:'public.utf8-plain-text',data:Buffer.from('original')}]]}),changeCount:()=>version,
    owns:(v,id)=>v===version&&items.some(item=>item.some(entry=>entry.type===native.PASTE_MARKER&&entry.data.toString()===id)),
    replace(next,expected){assert.equal(expected,version);if(++writes===2)throw Error('synthetic rollback failure');items=next.map(item=>item.map(e=>({...e,data:Buffer.from(e.data)})));version++;if(writes===1)Atomics.store(flag,0,1);return version;},close(){closed=true;}};
  sourceLoader(resolve('src/main/dictation/pasteboard-worker.ts'),{'node:worker_threads':{parentPort},'./macos-pasteboard':{...native,createMacPasteboard:()=>board}})('./pasteboard-worker');
  try {
    parentPort.emit('message',{id:1,action:'claim',text:'synthetic',canceled:flag.buffer});
    assert.equal(messages[0].ok,false);assert.match(messages[0].warning,/原剪贴板未能恢复/);assert.equal(writes,2);
  }finally{parentPort.emit('message',{id:2,action:'close',canceled:new SharedArrayBuffer(4)});}
  assert.equal(messages[1].ok,true);assert.equal(closed,true);
});
