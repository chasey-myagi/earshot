import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sourceLoader } from '../../../scripts/test-source-loader.mjs';
import { createDictationController } from '../dictation/controller.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((r,j)=>{resolve=r;reject=j;}); return {promise,resolve,reject}; };
function fixture(t) {
  const ipc = new EventEmitter(), windows = [], frames = [], loads = [];
  class Window {
    constructor() { this.webContents=new EventEmitter(); this.webContents.mainFrame={}; this.commands=[]; this.webContents.send=(...args)=>this.commands.push(args); windows.push(this); }
    isDestroyed(){return !!this.destroyed;} destroy(){this.destroyed=true;}
  }
  const entry=fileURLToPath(new URL('./dictation.ts',import.meta.url));
  const api=sourceLoader(entry,{electron:{BrowserWindow:Window,ipcMain:ipc},'../windows/load':{configureCapturePermissions(){},loadRendererPage(){const load=deferred();loads.push(load);return load.promise;}}})('./dictation');
  const abort=new AbortController(); let failures=0;
  const input={signal:abort.signal,pcm:bytes=>frames.push(Buffer.from(bytes)),failed:()=>failures++};
  t.after(()=>{abort.abort();api.closePreparedDictationCapture?.();});
  const emit=(name,bytes,win=windows.at(-1))=>ipc.emit(`dictation-capture:${name}`,{sender:win.webContents,senderFrame:win.webContents.mainFrame},bytes);
  return {api,ipc,windows,loads,input,abort,frames,emit,failures:()=>failures};
}
test('graph readiness and malformed or foreign PCM cannot advertise microphone readiness; first valid frame survives exactly once',async t=>{
  const h=fixture(t); let ready=false;
  const opened=h.api.startDictationCapture(h.input); opened.then(()=>ready=true,()=>{});
  h.loads[0].resolve(); await tick(); h.emit('ready'); await tick(); assert.equal(ready,false);
  for(const bytes of [new Uint8Array(),new Uint8Array(3),new Uint8Array(16386),{}])h.emit('pcm',bytes);
  h.ipc.emit('dictation-capture:pcm',{sender:{},senderFrame:{}},new Uint8Array([1,2]));await tick();assert.equal(ready,false);
  h.emit('pcm',new Uint8Array([1,2]));const handle=await opened;await tick();assert.deepEqual(h.frames,[Buffer.from([1,2])]);
  h.emit('pcm',new Uint8Array([3,4]));assert.deepEqual(h.frames,[Buffer.from([1,2]),Buffer.from([3,4])]);
  await handle.stop();h.emit('pcm',new Uint8Array([5,6]));assert.equal(h.frames.length,2);assert.equal(h.windows[0].destroyed,true);
  for(const event of ['ready','failed','pcm'])assert.equal(h.ipc.listenerCount(`dictation-capture:${event}`),0);
});
test('page prewarm is idempotent and sends no microphone start until explicitly captured',async t=>{
  const h=fixture(t);h.api.prepareDictationCapture();h.api.prepareDictationCapture();assert.equal(h.windows.length,1);
  h.loads[0].resolve();await tick();assert.deepEqual(h.windows[0].commands,[]);
  const opened=h.api.startDictationCapture(h.input);await tick();assert.equal(h.windows.length,1);assert.deepEqual(h.windows[0].commands,[['dictation-capture:start']]);
  h.emit('pcm',new Uint8Array([1,2]));await(await opened).stop();
  h.api.prepareDictationCapture();assert.equal(h.windows.length,2);h.api.closePreparedDictationCapture();assert.equal(h.windows[1].destroyed,true);
  h.loads[1].resolve();await tick();assert.deepEqual(h.windows[1].commands,[]);
});
for(const failure of ['abort','renderer','load','failed'])test(`startup ${failure} before first PCM rejects and destroys without late start or failure callback`,async t=>{
  const h=fixture(t);const opened=h.api.startDictationCapture(h.input);const rejected=assert.rejects(opened);
  if(failure==='abort')h.abort.abort();
  if(failure==='renderer')h.windows[0].webContents.emit('render-process-gone');
  if(failure==='load')h.loads[0].reject(Error('fixture')); else h.loads[0].resolve();
  if(failure==='failed')h.emit('failed');
  await rejected;await tick();assert.equal(h.windows[0].destroyed,true);assert.equal(h.failures(),0);
  if(failure!=='load')assert.deepEqual(h.windows[0].commands,[]);
  for(const event of ['ready','failed','pcm'])assert.equal(h.ipc.listenerCount(`dictation-capture:${event}`),0);
});
test('first PCM is retained through async capture wrappers into the controller stream and completed audio',async t=>{
  const h=fixture(t), sent=[], submitted=[];
  const controller=createDictationController({preflight:()=>null,preview:()=>true,target:()=>null,
    capture:async input=>{await Promise.resolve();return h.api.startDictationCapture(input);},
    stream:()=>({send:bytes=>sent.push(Buffer.from(bytes)),finish:async()=> '首词'}),
    transcribe:async()=>{throw Error('unexpected');},complete:async(text,input)=>{submitted.push(input.durationSec);return text;},changed(){}});
  t.after(()=>controller.cancel());const begin=controller.begin();await tick();h.loads[0].resolve();await tick();h.emit('ready');await tick();assert.equal(controller.snapshot().phase,'preparing');
  const first=Buffer.alloc(6400,7);h.emit('pcm',first);await begin;assert.equal(controller.snapshot().phase,'listening');assert.deepEqual(sent,[first]);
  await controller.end();assert.equal(controller.snapshot().text,'首词');assert.deepEqual(submitted,[0.2]);
});
for(const failure of ['abort','renderer','failed'])test(`active ${failure} cleans up once and reports only genuine capture failure`,async t=>{
  const h=fixture(t);const opened=h.api.startDictationCapture(h.input);h.loads[0].resolve();await tick();h.emit('pcm',Buffer.alloc(16384));const handle=await opened;
  if(failure==='abort')h.abort.abort();if(failure==='renderer')h.windows[0].webContents.emit('render-process-gone');if(failure==='failed')h.emit('failed');
  h.emit('failed');h.windows[0].webContents.emit('render-process-gone');await handle.stop();await handle.stop();
  assert.equal(h.failures(),failure==='abort'?0:1);assert.equal(h.windows[0].destroyed,true);assert.equal(h.frames[0].length,16384);
  for(const event of ['ready','failed','pcm'])assert.equal(h.ipc.listenerCount(`dictation-capture:${event}`),0);
});
test('already aborted request creates no renderer and leaves unused warm page available',async t=>{
  const h=fixture(t);h.abort.abort();await assert.rejects(h.api.startDictationCapture(h.input),/Canceled/);assert.equal(h.windows.length,0);
});
test('first PCM timeout releases capture and ignores a late page load',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const h=fixture(t);const opened=h.api.startDictationCapture(h.input);const rejected=assert.rejects(opened,/Microphone timeout/);
  t.mock.timers.tick(15000);await rejected;h.loads[0].resolve();await tick();assert.equal(h.windows[0].destroyed,true);assert.deepEqual(h.windows[0].commands,[]);
});
for(const failure of ['load','renderer'])test(`failed warm ${failure} is discarded and next capture uses a fresh page`,async t=>{
  const h=fixture(t);h.api.prepareDictationCapture();
  if(failure==='load')h.loads[0].reject(Error('fixture'));else h.windows[0].webContents.emit('render-process-gone');await tick();
  assert.equal(h.windows[0].destroyed,true);const opened=h.api.startDictationCapture(h.input);assert.equal(h.windows.length,2);
  h.loads[1].resolve();await tick();h.emit('pcm',new Uint8Array([4,5]));await(await opened).stop();
});
test('foreign subframes cannot start or fail a capture',async t=>{
  const h=fixture(t);let settled=false;const opened=h.api.startDictationCapture(h.input);opened.then(()=>settled=true,()=>{});h.loads[0].resolve();await tick();
  const event={sender:h.windows[0].webContents,senderFrame:{}};h.ipc.emit('dictation-capture:failed',event);h.ipc.emit('dictation-capture:pcm',event,new Uint8Array([1,2]));await tick();assert.equal(settled,false);assert.equal(h.windows[0].destroyed,undefined);
  h.emit('pcm',new Uint8Array([3,4]));await(await opened).stop();assert.deepEqual(h.frames,[Buffer.from([3,4])]);
});
