import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { sourceLoader } from '../../../scripts/test-source-loader.mjs';

// These are Electron boundary contracts, not native Spaces/keyboard-focus acceptance.
const state = (extra = {}) => ({ phase: 'listening', text: '', message: '可以说话了', startedAt: 1, level: 0, retryable: false, ...extra });
function fixture() {
  const windows = [], loads = [], workspaceCalls = [];
  let cursor = { x: 100, y: 100 };
  const displays = [{ x: 0, y: 24, width: 1440, height: 876 }];
  let cursorReads = 0;
  class Window {
    constructor(options) {
      this.options = options; this.visible = false; this.destroyed = false;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height }; this.boundsWrites = [];
      this.messages = []; this.inactiveShows = 0; this.webContents = new EventEmitter();
      this.webContents.send = (channel, value) => this.messages.push({ channel, value }); windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds) { this.bounds = { ...bounds }; this.boundsWrites.push(this.bounds); }
    setSize(width, height) { this.setBounds({ ...this.bounds, width, height }); }
    setAlwaysOnTop(value, level) { this.top = { value, level }; }
    setVisibleOnAllWorkspaces(...args) { workspaceCalls.push(args); }
    showInactive() { this.visible = true; this.inactiveShows++; }
    show() { throw new Error('HUD must not activate the app'); }
    focus() { throw new Error('HUD must not take keyboard focus'); }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.visible = false; }
  }
  const get = sourceLoader(resolve('src/main/windows/dictation.ts'), {
    electron: { BrowserWindow: Window, screen: { getCursorScreenPoint: () => { cursorReads++; return cursor; }, getDisplayNearestPoint(point) {
      const workArea = displays.find(area => point.x >= area.x && point.x < area.x + area.width && point.y >= area.y && point.y < area.y + area.height);
      assert.ok(workArea, `point ${JSON.stringify(point)} belongs to a fixture display`); return { workArea };
    } } },
    './load': { rendererPreloadPath: () => '/fixture/preload.js', loadRenderer: (win, hash) => loads.push({ win, hash }) },
  });
  const hud = get('./dictation').createDictationWindow();
  return { hud, windows, loads, workspaceCalls, loaded: () => windows.at(-1).webContents.emit('did-finish-load'),
    cursorReads: () => cursorReads, displays,
    moveTo(area) { displays.push(area); cursor = { x: area.x + 10, y: area.y + 10 }; } };
}

test('HUD uses a nonfocusable macOS panel without a process-wide workspace transform', () => {
  const f = fixture(); f.hud.show(state()); const win = f.windows[0];
  assert.equal(win.options.type, 'panel'); assert.equal(win.options.focusable, false);
  assert.equal(win.options.fullscreenable, false); assert.equal(win.options.show, false);
  assert.equal(f.loads[0].hash, 'dictation'); assert.equal(win.visible, false);
  f.loaded(); assert.equal(win.visible, true); assert.equal(win.inactiveShows, 1);
  assert.deepEqual(win.top, { value: true, level: 'floating' });
  assert.equal(JSON.stringify(f.workspaceCalls), JSON.stringify([[true,{visibleOnFullScreen:true,skipTransformProcessType:true}]]));
});

test('target screen wins over cursor before load and remains pinned through result updates', () => {
  const f = fixture();
  f.displays.push({ x: -1920, y: -200, width: 1920, height: 1080 });
  const target = { x: -1000, y: 300 };
  f.hud.show(state({ phase: 'preparing' }), target);
  target.x = 100; // Mutating a bridge-owned object cannot change this session's anchor.
  f.loaded(); const win = f.windows[0];
  assert.deepEqual(win.bounds, { x: -1150, y: -188, width: 380, height: 94 });
  f.moveTo({ x: 1440, y: 0, width: 900, height: 900 });
  f.hud.show(state({ level: .4 }));
  f.hud.show(state({ phase: 'result', text: '合成测试文字' }));
  assert.deepEqual(win.bounds, { x: -1150, y: -188, width: 380, height: 220 });
  assert.equal(f.cursorReads(), 0); assert.equal(win.inactiveShows, 1);
  assert.equal('screenPoint' in win.messages.at(-1).value, false, 'position stays out of renderer state');
});

test('missing target pins the initial cursor screen until idle then captures the next screen', () => {
  const f = fixture(); f.hud.show(state()); f.loaded(); const win = f.windows[0];
  f.moveTo({ x: -1920, y: -200, width: 1920, height: 1080 });
  f.hud.show(state({ level: .4 }));
  assert.deepEqual(win.bounds, { x: 530, y: 36, width: 380, height: 94 });
  assert.equal(f.cursorReads(), 1);
  f.hud.show(state({ phase: 'idle' })); f.hud.show(state());
  assert.deepEqual(win.bounds, { x: -1150, y: -188, width: 380, height: 94 });
  assert.equal(f.cursorReads(), 2);
});

test('visible expanded HUD follows work-area changes on its captured display', () => {
  const f = fixture(); f.hud.show(state()); f.loaded(); const win = f.windows[0];
  Object.assign(f.displays[0], { x: 0, y: 24, width: 320, height: 900 });
  f.hud.show(state({ phase: 'result', text: '合成测试文字' }));
  assert.deepEqual(win.bounds, { x: 0, y: 36, width: 320, height: 220 });
  assert.equal(win.messages.at(-1).value.text, '合成测试文字');
});

test('unchanged meter updates avoid redundant native bounds writes while still delivering state', () => {
  const f = fixture(); f.hud.show(state()); f.loaded(); const win = f.windows[0]; const writes = win.boundsWrites.length;
  f.hud.show(state({ level: .2 })); f.hud.show(state({ level: .8 }));
  assert.equal(win.boundsWrites.length, writes); assert.equal(win.messages.at(-1).value.level, .8);
});

test('idle remains hidden before first use and after loading; a later show uses the new display', () => {
  const f = fixture(); f.hud.show(state({ phase: 'idle' })); assert.equal(f.windows.length, 0);
  f.hud.show(state()); f.hud.show(state({ phase: 'idle' })); f.loaded(); const win = f.windows[0]; assert.equal(win.visible, false);
  f.moveTo({ x: 1440, y: 0, width: 900, height: 900 }); f.hud.show(state());
  assert.deepEqual(win.bounds, { x: 1700, y: 12, width: 380, height: 94 }); assert.equal(win.visible, true);
  f.hud.close(); assert.equal(win.destroyed, true);
});
