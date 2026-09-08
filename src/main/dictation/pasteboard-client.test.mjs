import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sourceLoader } from '../../../scripts/test-source-loader.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  t.mock.timers.enable({apis:['setTimeout']});
  const messages = [], workers = [];
  class Worker extends EventEmitter {
    constructor() { super(); workers.push(this); }
    unref() {}
    postMessage(message) { messages.push(message); }
  }
  const get = sourceLoader(fileURLToPath(new URL('./pasteboard-client.ts', import.meta.url)), {'node:worker_threads':{Worker}});
  return {client:get('./pasteboard-client').createPasteboardClient(), messages, workers,
    reply: (request, ok=true) => workers[0].emit('message',{id:request.id,ok,value:request.action==='claim'?'lease':undefined,error:ok?undefined:'已取消输入'})};
}
test('slow native request blocks concurrent writes but a late canceled reply restores explicit copy', async t => {
  const f=fixture(t), claim=f.client.claim('synthetic',new AbortController().signal);
  const rejected=assert.rejects(claim,/超时/); await tick();
  t.mock.timers.tick(2000); await rejected;
  assert.equal(Atomics.load(new Int32Array(f.messages[0].canceled),0),1);
  await assert.rejects(f.client.copy('copy'),/仍在收尾/); assert.equal(f.messages.length,1);
  f.reply(f.messages[0],false);
  const copy=f.client.copy('copy'); await tick(); f.reply(f.messages[1]); await copy;
  assert.equal(f.workers.length,1); assert.equal(f.messages[1].action,'copy');
});
test('close waits for a cleanup reply, including behind a timed-out operation', async t => {
  const f=fixture(t), claim=f.client.claim('synthetic',new AbortController().signal);
  const rejected=assert.rejects(claim); await tick(); t.mock.timers.tick(2000); await rejected;
  let done=false; const close=f.client.close().then(()=>{done=true;}); await tick();
  assert.equal(f.messages[1].action,'close'); assert.equal(done,false);
  f.reply(f.messages[0],false); await tick(); assert.equal(done,false);
  f.reply(f.messages[1]); await close; assert.equal(done,true);
  f.workers[0].emit('exit',0); await f.client.close();
});
test('cleanup timeout rejects so app exit cannot discard pending originals; a late ack settles subsequent close', async t => {
  const f=fixture(t), copy=f.client.copy('synthetic'); await tick(); f.reply(f.messages[0]); await copy;
  const close=f.client.close(), rejected=assert.rejects(close,/超时/); await tick(); t.mock.timers.tick(2000); await rejected;
  f.reply(f.messages[1]); await f.client.close(); assert.equal(f.messages.length,2);
});
test('worker failure gives an actionable restart error without starting a competing worker', async t => {
  const f=fixture(t), copy=f.client.copy('synthetic'), rejected=assert.rejects(copy,/重新打开/);
  await tick(); f.workers[0].emit('error',new Error('worker crashed')); await rejected;
  await assert.rejects(f.client.copy('again'),/重新打开/); assert.equal(f.workers.length,1);
  await f.client.close(); assert.equal(f.messages.length,1);
});

test('worker rollback warning survives serialization into a rejected claim', async t => {
  const f=fixture(t),claim=f.client.claim('synthetic',new AbortController().signal);
  const rejected=assert.rejects(claim,error=>error.warning==='原剪贴板未能恢复，识别文字已保留');await tick();
  f.workers[0].emit('message',{id:f.messages[0].id,ok:false,error:'恢复失败',warning:'原剪贴板未能恢复，识别文字已保留'});await rejected;
});
