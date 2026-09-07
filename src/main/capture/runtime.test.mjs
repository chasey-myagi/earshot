import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createPcmWavWriter } from '../store/wav.ts';

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'earshot-capture-sender-'));
  const ipc = new EventEmitter(), handlers = new Map(), windows = [], frames = [];
  ipc.handle = (name, fn) => handlers.set(name, fn); ipc.removeHandler = name => handlers.delete(name);
  const partition = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  class Window {
    constructor() { this.webContents = new EventEmitter(); this.webContents.mainFrame = {}; this.webContents.session = partition; this.webContents.getURL = () => this.url; this.webContents.setWindowOpenHandler = () => {}; windows.push(this); }
    isDestroyed() { return !!this.closed; }
    close() { this.closed = true; }
    async loadFile(file) { this.url = pathToFileURL(file).href; this.webContents.emit('did-finish-load'); }
    async loadURL(url) { this.url = url; this.webContents.emit('did-finish-load'); }
  }
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL('./runtime.ts', import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const ports = {
    electron: { BrowserWindow: Window, ipcMain: ipc, desktopCapturer: {getSources: async () => [{id:'screen-fixture'}]}, session: {defaultSession:partition, fromPartition: () => partition} },
    'node:fs': { existsSync }, 'node:path': {join}, '../store/wav': {createPcmWavWriter}, './screen': {noteScreenGranted() {}},
    '../windows/load': { loadRendererPage: (win, page) => win.loadFile(`/app/out/renderer/${page}`), configureCapturePermissions() {} },
  };
  runInNewContext(source, {exports, require: name => {if (!(name in ports)) throw Error(`unmapped ${name}`);return ports[name];}, process:{env:{}}, __dirname:'/app/out/main', setTimeout, clearTimeout, Buffer, Uint8Array, ArrayBuffer, Promise});
  const started = exports.startCapture({destDir:root,onPcm:(track, bytes)=>frames.push({track,bytes}),onCrash(){}});
  t.after(async () => { if(windows[0]) ipc.emit('capture:ready', {sender:windows[0].webContents,senderFrame:windows[0].webContents.mainFrame}); try {await (await started).stop();} finally {rmSync(root,{recursive:true,force:true});} });
  return {root,ipc,handlers,windows,frames,started};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const eventFor = win => ({sender:win.webContents,senderFrame:win.webContents.mainFrame});

test('foreign readiness cannot start a capture or consume the real readiness listener', async t => {
  const h=harness(t);await tick();let ready=false;h.started.then(()=>{ready=true;});
  h.ipc.emit('capture:ready',{sender:{},senderFrame:{}});await tick();assert.equal(ready,false);
  h.ipc.emit('capture:ready',eventFor(h.windows[0]));await h.started;assert.equal(ready,true);
});
test('capture begin rejects a foreign renderer but returns the screen to its own renderer', async t => {
  const h=harness(t);await tick();
  assert.throws(()=>h.handlers.get('capture:begin')({sender:{},senderFrame:{}}),/capture|采集/i);
  assert.equal(h.handlers.get('capture:begin')(eventFor(h.windows[0])).sourceId,'screen-fixture');
});
test('foreign, malformed, oversized and odd PCM never pollutes the current WAV', async t => {
  const h=harness(t);await tick();const win=h.windows[0], event=eventFor(win);
  h.ipc.emit('capture:ready',event);const capture=await h.started;
  h.ipc.emit('capture:pcm',{sender:{},senderFrame:{}},'you',new Uint8Array([1,2]));
  h.ipc.emit('capture:pcm',event,'you',new Uint8Array(16386));
  h.ipc.emit('capture:pcm',event,'you',new Uint8Array([1]));
  assert.doesNotThrow(()=>h.ipc.emit('capture:pcm',event,'you',{malformed:true}));
  h.ipc.emit('capture:pcm',event,'wrong',new Uint8Array([1,2]));
  h.ipc.emit('capture:pcm',event,'you',new Uint8Array([3,4]));
  await capture.stop();assert.equal(h.frames.length,1);assert.deepEqual(readFileSync(join(h.root,'mic.wav')).subarray(44),Buffer.from([3,4]));
});
