// Detail playback and timestamp requests retain the requested session across queued switches. Audio markers distinguish the two fixture sessions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createPlaybackController } from './playback.ts';
import { createMediaPlayback } from '../renderer/media-playback.ts';
import { createSessionStore } from './store/sessions.ts';
import { createPcmWavWriter } from './store/wav.ts';
import { createRecordingActions } from './recording-actions.ts';

function parse(relative, kind = ts.ScriptKind.TS) {
  const url = new URL(relative, import.meta.url);
  return ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}
function execute(source, globals) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return runInNewContext(compiled, { exports: {}, ...globals });
}

// Read the actual public callback, without reimplementing its decision or exporting a private helper.
const librarySource = parse('../renderer/Library.tsx', ts.ScriptKind.TSX);
let detailPlaySource;
function visit(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(librarySource) === 'SessionPane') {
    const attribute = node.attributes.properties.find(p => ts.isJsxAttribute(p) && p.name.text === 'onPlay');
    detailPlaySource = attribute?.initializer?.expression?.getText(librarySource);
  }
  ts.forEachChild(node, visit);
}
visit(librarySource);
assert.ok(detailPlaySource, 'production SessionPane must expose the detail play callback');

// Execute the unmodified playback registration section, including its validation functions.
// Application startup/recording are outside this scenario; no production collaborator is mocked.
const mainSource = parse('./index.ts');
const registration = mainSource.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'registerIpc');
const statements = [...registration.body.statements];
function channel(node) {
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return null;
  const call = node.expression;
  return call.expression.getText(mainSource).startsWith('ipcMain.') && ts.isStringLiteral(call.arguments[0])
    ? call.arguments[0].text : null;
}
const first = statements.findIndex(n => channel(n) === 'app:playbackHost');
const last = statements.findIndex(n => channel(n) === 'app:stopPlayback');
assert.ok(first >= 0 && last > first, 'production playback IPC registration must be present');
const playbackIpcSource = statements.slice(first, last + 1).map(n => n.getText(mainSource)).join('\n');
const preloadSource = readFileSync(new URL('../preload/index.ts', import.meta.url), 'utf8');

// Browser boundary: deterministic media events; all command/status logic remains in the real host.
class Media extends EventTarget {
  src = ''; paused = true; ended = false; readyState = 0; duration = 30;
  seeking = false; time = 0;
  get currentTime() { return this.time; }
  set currentTime(value) {
    this.time = value; this.seeking = true;
    queueMicrotask(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); });
  }
  async play() { this.paused = false; this.dispatchEvent(new Event('play')); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() {
    if (this.src) queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); });
    else this.readyState = 0;
  }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'earshot-C2-detail-play-'));
  const store = createSessionStore(root);
  function recording(sample) {
    const doc = store.createRecording();
    for (const track of ['mic.wav', 'system.wav']) {
      const writer = createPcmWavWriter(join(store.sessionDir(doc.id), track));
      try {
        const pcm = Buffer.alloc(30 * 16000 * 2);
        for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(sample, offset);
        writer.write(pcm);
      } finally { writer.close(); }
    }
    store.finalize(doc.id, 'complete', { durationSec: 30 });
    return doc.id;
  }
  const a = recording(1000), b = recording(2000);
  const handlers = new Map(), listeners = new Map(), media = [], results = [];
  const sender = {};
  let api, hold = null, held = null;
  const playback = createPlaybackController({ send: command => listeners.get('earshot:playback')({}, command) });
  const recordingActions = createRecordingActions({
    start: async () => { throw Error('recording is outside this test'); },
    finish: async () => { throw Error('recording is outside this test'); }, onChange() {},
  });
  execute(playbackIpcSource, {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
    playback, store, library: { webContents: sender }, live: null, recordingActions,
    deletion: { blocked: () => false }, dictation: { busy: () => false },
  });
  execute(preloadSource, { require: name => {
    assert.equal(name, 'electron');
    return {
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: {
        async invoke(name, ...args) {
          const result = await handlers.get(name)({ sender }, ...args);
          if (result && typeof result.ok === 'boolean') results.push({ channel: name, ok: result.ok });
          return result;
        },
        send(name, report) {
          if (hold && report.ack === true) {
            held = () => handlers.get(name)({ sender }, report);
            const arrived = hold; hold = null; arrived.resolve();
          } else handlers.get(name)({ sender }, report);
        },
        on: (name, fn) => listeners.set(name, fn), removeListener: name => listeners.delete(name),
      },
    };
  } });
  const host = createMediaPlayback({
    createAudio: () => { const audio = new Media(); media.push(audio); return audio; },
    report: report => api.reportPlayback(report),
  });
  const unsubscribe = api.onPlaybackCommand(command => void host.command(command));
  t.after(async () => {
    try {
      held?.(); held = null;
      await api.stopPlayback();
    } finally {
      host.dispose(); unsubscribe(); await api.playbackHost(false);
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    a, b, api, playback, results,
    holdAcknowledgement() {
      hold = Promise.withResolvers();
      return hold.promise;
    },
    releaseAcknowledgement() { assert.ok(held, 'media acknowledgement reached the explicit barrier'); held(); held = null; },
    async sample() {
      const current = media.at(-1);
      const offset = 44 + current.currentTime * 32000;
      const response = playback.respond(new Request(current.src, { headers: { Range: `bytes=${offset}-${offset + 1}` } }));
      assert.equal(response.status, 206, 'active media source must serve the requested PCM byte range');
      return Buffer.from(await response.arrayBuffer()).readInt16LE(0);
    },
  };
}

async function detailPlayAfterSeek(t, switchSession) {
  const h = fixture(t);
  await h.api.playbackHost(true);
  assert.equal((await h.api.playSession(h.a)).ok, true);
  assert.equal((await h.api.pausePlayback()).ok, true);
  const snap = { playback: h.playback.snapshot() };
  assert.equal(snap.playback.sessionId, h.a);
  assert.equal(snap.playback.status, 'paused');
  assert.equal(snap.playback.positionSec, 0);
  let detailError = null;
  const onPlay = execute(`(${detailPlaySource})`, {
    snap, window: { earshot: h.api }, setActionError: value => { detailError = value; },
  });
  const arrived = h.holdAcknowledgement();
  const seeking = h.api.seekPlayback({ sessionId: h.a, positionSec: 3 });
  await arrived;
  const switching = switchSession ? h.api.playSession(h.b) : null;
  const clicking = onPlay(h.a);
  h.releaseAcknowledgement();
  const completed = await Promise.all([seeking, ...(switching ? [switching] : [])]);
  await clicking;
  assert.deepEqual(completed.map(result => result.ok), switchSession ? [true, true] : [true]);
  assert.equal(detailError, null, 'detail click must not report an error');
  const state = h.playback.snapshot();
  const observed = {
    session: state.sessionId === h.a ? 'A' : state.sessionId === h.b ? 'B' : state.sessionId,
    status: state.status, positionSec: state.positionSec, sample: await h.sample(), error: state.error ?? null,
  };
  t.diagnostic(JSON.stringify({ observed, detailError, results: h.results }));
  return observed;
}

test('detail play retains requested session A across a queued play of B', async t => {
  const observed = await detailPlayAfterSeek(t, true);
  assert.deepEqual({ session: observed.session, status: observed.status, sample: observed.sample, error: observed.error },
    { session: 'A', status: 'playing', sample: 1000, error: null },
    'A detail play must select and play A audio after an earlier queued switch to B');
});

test('detail play resumes session A at the seek position without a queued switch', async t => {
  const observed = await detailPlayAfterSeek(t, false);
  assert.deepEqual(observed, { session: 'A', status: 'playing', positionSec: 3, sample: 1000, error: null });
});
