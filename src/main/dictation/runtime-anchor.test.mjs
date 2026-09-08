import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceLoader } from '../../../scripts/test-source-loader.mjs';
import { DEFAULT_SHORTCUTS } from '../../shared/dictation.ts';

function fixture(t, bridge = {}, delivery = 'preview') {
  const root = mkdtempSync(join(tmpdir(), 'earshot-runtime-anchor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'shortcuts.json'), JSON.stringify({ ...DEFAULT_SHORTCUTS, delivery }));
  const handlers = new Map(), shows = [];
  let target = null, captures = 0, microphone, allowed = true;
  const get = sourceLoader(fileURLToPath(new URL('./runtime.ts', import.meta.url)), {
    electron: { clipboard: {}, shell: {}, ipcMain: { handle: (key, fn) => handlers.set(key, fn) }, powerMonitor: new EventEmitter(),
      globalShortcut: { register: () => true, unregister() {} },
      systemPreferences: { getMediaAccessStatus: () => allowed ? 'granted' : 'denied', isTrustedAccessibilityClient: () => true } },
    '../capture/dictation': { prepareDictationCapture() {}, closePreparedDictationCapture() {},
      startDictationCapture: async input => { microphone = input; return { stop: async () => {} }; } },
    '../windows/dictation': { createDictationWindow: () => ({ prepare() {},
      show: (state, point) => shows.push({ state: { ...state }, point: point ? { ...point } : undefined }), close() {},
    }) },
    '../providers/dictation-stream': { startDictationStream: () => ({ send() {}, finish: async () => '合成文字' }) },
  });
  const runtime = get('./runtime').createDictationRuntime({ root, store: { saveDictation() {} }, apiKey: () => 'fixture-key',
    meetingBusy: () => false, startMeeting: async () => ({ ok: true }), showMeeting() {}, stopPlayback: async () => {}, changed() {},
    bridge: { captureTarget: () => { captures++; if (target instanceof Error) throw target; return target; }, held: () => false, escape: () => false, ...bridge },
  });
  t.after(() => runtime.close()); runtime.register();
  return { shows, runtime, captures: () => captures, setTarget: value => { target = value; }, deny: () => { allowed = false; },
    pcm: () => microphone.pcm(Buffer.alloc(16000, 2)), invoke: name => handlers.get(`app:${name}`)() };
}
const targetAt = (x, y) => ({ screenPoint: { x, y }, insert: () => ({kind: 'verified'}), release() {} });

test('real controller/runtime forwards a captured target point through preparing, meter, transcription and result', async t => {
  const f = fixture(t), target = targetAt(-1000, 300); f.setTarget(target);
  assert.equal((await f.invoke('beginDictation')).ok, true);
  target.screenPoint.x = 500; f.pcm(); await f.invoke('endDictation');
  const active = f.shows.filter(({ state }) => state.phase !== 'idle');
  assert.ok(['preparing', 'listening', 'transcribing', 'result'].every(phase => active.some(item => item.state.phase === phase)));
  for (const { state, point } of active) { assert.deepEqual(point, { x: -1000, y: 300 }); assert.equal('screenPoint' in state, false); }
  assert.equal(f.captures(), 1);
  await f.invoke('cancelDictation'); assert.equal(f.shows.at(-1).state.phase, 'idle'); assert.equal(f.shows.at(-1).point, undefined);
  f.setTarget(targetAt(1800, 200)); await f.invoke('beginDictation');
  assert.deepEqual(f.shows.at(-1).point, { x: 1800, y: 200 }); assert.equal(f.captures(), 2);
});

test('a later missing or failed target cannot reuse the previous dictation point', async t => {
  const f = fixture(t); f.setTarget(targetAt(-1000, 300)); await f.invoke('beginDictation'); await f.invoke('cancelDictation');
  for (const target of [null, { insert: () => ({kind: 'verified'}), release() {} }, new Error('AX unavailable')]) {
    f.setTarget(target); const from = f.shows.length; await f.invoke('beginDictation');
    assert.ok(f.shows.slice(from).every(item => item.point === undefined)); await f.invoke('cancelDictation');
  }
});

test('preflight failure still anchors its immediate feedback to the current work screen', async t => {
  const f = fixture(t); f.setTarget(targetAt(-1000, 300)); await f.invoke('beginDictation'); f.pcm(); await f.invoke('endDictation');
  f.deny(); assert.equal((await f.invoke('beginDictation')).ok, false);
  assert.equal(f.shows.at(-1).state.phase, 'error'); assert.deepEqual(f.shows.at(-1).point, {x:-1000,y:300}); assert.equal(f.captures(), 2);
});


test('finishing an earlier manual copy cannot cancel a newer dictation', async t => {
  let finish; const copied=new Promise(resolve=>{finish=resolve;});
  const f=fixture(t,{copy:()=>copied}); f.setTarget(targetAt(50,50));
  await f.invoke('beginDictation');f.pcm();await f.invoke('endDictation');
  const copy=f.invoke('copyDictation');await f.invoke('beginDictation');
  assert.equal(f.runtime.snapshot().phase,'listening');
  finish();assert.equal((await copy).ok,true);assert.equal(f.runtime.snapshot().phase,'listening');
});


test('post-cancel result keeps the original work-screen anchor', async t => {
  let finish;const outcome=new Promise(resolve=>{finish=resolve;});
  const f=fixture(t,{},'direct');f.setTarget({screenPoint:{x:-1000,y:300},insert:()=>outcome,release(){}});
  await f.invoke('beginDictation');f.pcm();const end=f.invoke('endDictation');await new Promise(resolve=>setImmediate(resolve));
  const cancel=f.invoke('cancelDictation');finish({kind:'posted-unconfirmed'});await Promise.all([end,cancel]);
  assert.equal(f.runtime.snapshot().resultKind,'delivery-canceled');assert.deepEqual(f.shows.at(-1).point,{x:-1000,y:300});
});
