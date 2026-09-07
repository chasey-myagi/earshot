import { sourceLoader } from "../../scripts/test-source-loader.mjs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as permissions from "./capture/permissions.ts";
import * as screenStatus from "./capture/screen-status.ts";
import * as sessions from "./store/sessions.ts";
import * as snapshot from "./store/snapshot.ts";
import * as wav from "./store/wav.ts";
import * as live from "./live.ts";
import * as navigation from "./windows/navigation.ts";
import * as recordingActions from "./recording-actions.ts";
import * as orchestration from "./jobs/orchestrate.ts";
import * as playbackModule from "./playback.ts";
import * as exportsModule from "./export.ts";
import * as transcribing from "./live-transcriber.ts";
import * as speakerNamesModule from "./speaker-names.ts";

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL("./index.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Execute the actual main entry and IPC registration, replacing only external effects. */
async function launch(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "earshot-main-ipc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const handlers = new Map(), events = new Map(), windows = [];
  const calls = { starts: 0, stops: 0, plays: 0, settled: [], queued: [], quits: 0, errors: [], mediaCommands: [], revealed: [] };
  let ready;
  let store;
  let captureOptions;
  let writers;
  class Window {
    visible = false;
    destroyed = false;
    handlers = new Map();
    webContents = { setWindowOpenHandler() {}, send(name, command) { if (name === "earshot:playback") calls.mediaCommands.push(command); }, on() {}, getURL: () => "local" };
    constructor() { windows.push(this); }
    on(event, handler) { this.handlers.set(event, handler); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    center() {}
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    close() {
      let prevented = false;
      this.handlers.get("close")?.({ preventDefault() { prevented = true; } });
      if (!prevented) { this.destroyed = true; this.handlers.get("closed")?.(); }
    }
    static fromWebContents(sender) { return windows.find(w => w.webContents === sender); }
    static getAllWindows() { return windows.filter(w => !w.destroyed); }
  }
  const app = {
    setName() {}, commandLine: { appendSwitch() {} }, getAppPath: () => root,
    getPath: () => root, isReady: () => true, on: (event, fn) => events.set(event, fn),
    whenReady: () => ({ then: fn => { ready = fn(); } }),
    quit() { calls.quits++; events.get("before-quit")?.({ preventDefault() {} }); },
  };
  const modules = {
    electron: { protocol: { registerSchemesAsPrivileged() {}, handle() {} }, app, BrowserWindow: Window, dialog: { showErrorBox: (...args) => calls.errors.push(args), showSaveDialog: (...args) => overrides.save?.(...args) }, shell: { showItemInFolder: path => calls.revealed.push(path) },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => handlers.set(name, handler) },
      globalShortcut: { register: () => true, unregister() {} }, powerMonitor: { on() {}, removeListener() {} },
      systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => false } },
    "./capture/permissions": permissions,
    "./capture/screen-status": screenStatus,
    "./capture/screen": { installScreenPicker() {}, probeScreenPermission: () => "granted" },
    "./capture/runtime": { startCapture: async options => {
      calls.starts++;
      captureOptions = options;
      await overrides.start?.();
      writers = Object.fromEntries([['you', 'mic.wav'], ['other', 'system.wav']].map(([track, name]) =>
        [track, wav.createPcmWavWriter(join(options.destDir, name))]));
      return { stop: async () => {
        calls.stops++;
        try { await overrides.stop?.(); }
        finally { for (const writer of Object.values(writers)) writer.close(); }
      } };
    } },
    "./jobs/orchestrate": {
      ...orchestration,
      settleSession: (...args) => { orchestration.settleSession(...args); calls.settled.push(args[1]); },
      finishRecordingJobs: (queue, id, reason) => orchestration.finishRecordingJobs({
        ...queue, process: async () => { calls.queued.push(id); },
      }, id, reason),
    },
    "./store/key": { readStoredKey: () => "fixture-only-not-a-key" },
    "./live": live,
    "./playback": overrides.realPlayback ? { createPlaybackController: options => playbackModule.createPlaybackController({ ...options, timeoutMs: overrides.mediaTimeout ?? 1000 }) } : {
      createPlaybackController: () => ({
        snapshot: () => null, hostClosed() {}, hostReady() {}, report() {}, respond() {}, rename() {},
        stopAndWait: async () => { await overrides.playbackStop?.(); },
        play: () => { calls.plays++; return { ok: true }; },
        pause: async () => ({ ok: true }), resume: async () => ({ ok: true }), seek: async () => ({ ok: true }), seekSession: async () => ({ ok: true }),
      }),
    },
    "./live-transcriber": { createLiveTranscriber: opts => transcribing.createLiveTranscriber({ ...opts, connect: overrides.connect ?? socketServer().connect }) },
    "./store/sessions": { isSessionId: sessions.isSessionId, createSessionStore: dir => { store = sessions.createSessionStore(dir); return store; } },
    "./store/snapshot": snapshot, "./store/wav": wav,
    "./speaker-names": speakerNamesModule,
    "./voiceprint/enroll": { enrollSpeaker: async () => {} },
    "./export": exportsModule,
    "./windows/glance": { createGlanceWindow: () => new Window() },
    "./windows/library": { createLibraryWindow: () => new Window() },
    "./windows/load": { loadRenderer() {} },
    "./windows/navigation": navigation,
    "./recording-actions": recordingActions,
  };
  const loadSource = sourceLoader(fileURLToPath(new URL("./index.ts", import.meta.url)), { ...modules, "./dictation/macos": { createMacDictationBridge: () => undefined } });
  runInNewContext(compiled, {
    exports: {}, require: name => name.startsWith("node:") ? require(name) : modules[name] ?? loadSource(name),
    console: { log() {}, error() {} }, process, setTimeout, clearTimeout,
  });
  await ready;
  return { store, calls, windows, events,
    mediaReady: (sender = windows[0].webContents) => handlers.get("app:playbackHost")({ sender }, true),
    mediaReport: (report, sender = windows[0].webContents) => handlers.get("app:playbackReport")({ sender }, report),
    crash: () => captureOptions.onCrash(),
    pcm: (track, pcm) => { writers[track].write(pcm); captureOptions.onPcm(track, pcm); },
    invoke: (name, raw) => handlers.get(`app:${name}`)({ sender: windows[0].webContents }, raw),
    snap: () => handlers.get("app:snapshot")(),
  };
}

test("actual playback IPC refuses starting, recording and stopping; selected history never changes the recording owner", async t => {
  const start = deferred(), stop = deferred();
  const h = await launch(t, { start: () => start.promise, stop: () => stop.promise });
  const history = h.store.createRecording();
  h.store.finalize(history.id, "complete", { durationSec: 120 });
  writeFileSync(join(h.store.sessionDir(history.id), 'live.jsonl'), JSON.stringify({ id: 'history-turn', track: 'other', speaker: '对方', tStartMs: 0, text: 'An actual historical speaker' }) + '\n');
  const historyBefore = JSON.stringify(h.store.readSession(history.id));
  const starting = h.invoke("start");
  assert.equal(h.snap().capturePhase, "starting");
  assert.equal(h.invoke("playSession", history.id).ok, false);
  for (const action of ['pausePlayback','resumePlayback','seekPlayback']) {
    const result = await h.invoke(action, { sessionId: history.id, positionSec: 1, resume: true });
    assert.equal(result.ok, false); assert.equal(result.code, 'busy');
  }
  start.resolve(); await starting;
  const current = h.snap().recording.sessionId;
  h.invoke("selectSession", history.id);
  assert.equal(h.snap().selectedId, history.id);
  assert.equal(h.invoke("playSession", history.id).ok, false);
  for (const action of ['pausePlayback','resumePlayback','seekPlayback']) {
    const result = await h.invoke(action, { sessionId: history.id, positionSec: 1, resume: true });
    assert.equal(result.ok, false); assert.equal(result.code, 'busy');
  }
  assert.equal(h.invoke("renameSpeaker", { sessionId: current, from: "对方", to: "王明" }).ok, false);
  const renamed = h.invoke("renameSpeaker", { sessionId: history.id, from: "对方", to: "王明" });
  assert.equal(renamed.ok, true);
  assert.equal(h.snap().selected.turns[0].speaker, '王明');
  assert.equal(h.invoke('undoSpeakerRename', renamed.undoId).ok, true);
  assert.equal(h.snap().selected.turns[0].speaker, '对方');
  const stopping = h.invoke("stop");
  assert.equal(h.snap().capturePhase, "stopping");
  assert.equal(h.invoke("playSession", history.id).ok, false);
  for (const action of ['pausePlayback','resumePlayback','seekPlayback']) {
    const result = await h.invoke(action, { sessionId: history.id, positionSec: 1, resume: true });
    assert.equal(result.ok, false); assert.equal(result.code, 'busy');
  }
  stop.resolve(); await stopping;
  assert.deepEqual(h.calls.settled, [current]);
  assert.equal(JSON.stringify(h.store.readSession(history.id)), historyBefore);
  assert.equal(h.snap().selectedId, current);
  assert.equal(h.calls.starts, 1); assert.equal(h.calls.stops, 1); assert.equal(h.calls.plays, 0);
  assert.equal(h.invoke("playSession", history.id).ok, true);
});

test("starting waits for the previous playback exit before allocating a new session", async t => {
  const oldPlayer = deferred();
  const h = await launch(t, { playbackStop: () => oldPlayer.promise });
  const starting = h.invoke("start");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.calls.starts, 0);
  assert.equal(h.store.listSummaries().length, 0);
  oldPlayer.resolve();
  assert.equal((await starting).ok, true);
  assert.equal(h.calls.starts, 1);
  await h.invoke("stop");
});

test("capture is never created if existing playback cannot stop, and can retry after recovery", async t => {
  let failed = true;
  const h = await launch(t, { playbackStop: async () => { if (failed) throw Error("player stuck"); } });
  assert.equal((await h.invoke("start")).ok, false);
  assert.equal(h.calls.starts, 0);
  assert.equal(h.store.listSummaries().length, 0);
  assert.equal(h.snap().capturePhase, "idle");
  failed = false;
  assert.equal((await h.invoke("start")).ok, true);
  assert.equal(h.calls.starts, 1);
  await h.invoke("stop");
});

test("Dock activation restores the current recording and window close never stops capture", async t => {
  const h = await launch(t);
  await h.invoke("start");
  const current = h.snap().recording.sessionId;
  h.invoke("selectSession", "history");
  h.events.get("activate")();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.snap().selectedId, current);
  assert.equal(h.windows[0].visible, true);
  assert.equal(h.windows[1].visible, false);
  h.windows[0].close();
  assert.equal(h.windows[0].destroyed, false);
  assert.equal(h.windows[1].visible, true);
  h.invoke("hideGlance");
  assert.equal(h.windows[1].visible, false);
  assert.equal(h.calls.stops, 0);
  h.invoke("showLibrary");
  assert.equal(h.snap().selectedId, current);
  await h.invoke("stop");
});

test("repeated quit requests wait for pending startup and finalization", async t => {
  const start = deferred();
  const h = await launch(t, { start: () => start.promise });
  const starting = h.invoke("start");
  let prevented = 0;
  const requestQuit = () => h.events.get("before-quit")({ preventDefault() { prevented++; } });
  requestQuit(); requestQuit();
  assert.equal(prevented, 2);
  start.resolve(); await starting;
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(h.calls.starts, 1); assert.equal(h.calls.stops, 1);
  assert.equal(h.calls.quits, 1);
});


function socketServer() {
  const sockets = [];
  return { sockets, connect: () => {
    const callbacks = {};
    const socket = { send() {}, close() {},
      onOpen(fn) { callbacks.open = fn; }, onMessage(fn) { callbacks.message = fn; },
      onError(fn) { callbacks.error = fn; }, onClose(fn) { callbacks.close = fn; },
      ready() { callbacks.message(JSON.stringify({ header: { event: "task-started" } })); },
      lose() { callbacks.close(); },
      sentence(text, partial = false, start = 0, sentenceId = 1) { callbacks.message(JSON.stringify({
        header: { event: "result-generated" }, payload: { output: { sentence: {
          sentence_id: sentenceId, text, begin_time: start, sentence_end: !partial,
        } } },
      })); },
    };
    sockets.push(socket); return socket;
  } };
}

for (const stoppingFirst of [false, true]) test(`quit remains blocked throughout real deferred capture stop (${stoppingFirst ? 'manual stop first' : 'quit first'})`, async t => {
  const stop = deferred();
  const h = await launch(t, { stop: () => stop.promise });
  await h.invoke("start");
  const id = h.snap().recording.sessionId;
  h.pcm("you", Buffer.alloc(32000, 1));
  const pending = stoppingFirst ? h.invoke("stop") : null;
  let prevented = 0;
  const quit = () => h.events.get("before-quit")({ preventDefault() { prevented++; } });
  quit(); quit();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(prevented, 2);
  assert.equal(h.calls.quits, 0);
  assert.equal(h.store.readSession(id).status, "recording");
  stop.resolve();
  if (pending) await pending;
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.store.readSession(id).status, "complete");
  assert.equal(readFileSync(join(h.store.sessionDir(id), "mic.wav")).readUInt32LE(40), 32000);
  assert.equal(h.calls.queued.length, 0, "a quit arriving during manual stop must not start cloud jobs");
  assert.equal(h.store.readSession(id).jobs.refined.status, "failed");
  assert.equal(h.calls.quits, 1);
});

for (const captureFails of [false, true]) test(`real finalization failure remains retryable and preserves ${captureFails ? 'incomplete capture' : 'complete capture'}`, async t => {
  const h = await launch(t, { stop: async () => { if (captureFails) throw Error("capture stopped unexpectedly"); } });
  await h.invoke("start");
  const id = h.snap().recording.sessionId;
  h.pcm("you", Buffer.alloc(32000, 1));
  h.pcm("other", Buffer.alloc(32000, 2));
  const path = join(h.store.sessionDir(id), "session.json");
  chmodSync(path, 0o400);
  t.after(() => { try { chmodSync(path, 0o600); } catch {} });
  assert.equal((await h.invoke("stop")).ok, false);
  assert.equal(h.snap().recording.sessionId, id);
  assert.equal(h.store.readSession(id).status, "recording");
  assert.equal((await h.invoke("start")).ok, false);
  assert.equal(h.invoke("playSession", id).ok, false);
  assert.equal(h.snap().capturePhase, 'finalize_failed');
  for (const action of ['pausePlayback','resumePlayback','seekPlayback']) {
    const result = await h.invoke(action, { sessionId: id, positionSec: 0, resume: true });
    assert.equal(result.ok, false); assert.equal(result.code, 'busy');
  }
  assert.equal(h.calls.mediaCommands.length, 0);
  chmodSync(path, 0o600);
  assert.equal((await h.invoke("stop")).ok, true);
  assert.equal(h.store.readSession(id).status, captureFails ? "incomplete" : "complete");
  assert.equal(h.snap().recording, null);
  for (const track of ["mic.wav", "system.wav"]) {
    const file = readFileSync(join(h.store.sessionDir(id), track));
    assert.equal(file.readUInt32LE(40), 32000);
    assert.equal(file.length, 32044);
  }
});

test("actual reconnect IPC clears drafts, preserves WAV and confirmed disk transcript, and rejects late generations", async t => {
  const start = deferred(), stop = deferred(), server = socketServer();
  const h = await launch(t, { connect: server.connect, start: () => start.promise, stop: () => stop.promise });
  assert.equal(h.invoke("retryRealtime").ok, false);
  assert.equal(server.sockets.length, 0);
  const starting = h.invoke("start");
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(h.invoke("retryRealtime").ok, false);
  assert.equal(server.sockets.length, 2);
  start.resolve(); await starting;
  const id = h.snap().recording.sessionId;
  server.sockets.forEach(socket => socket.ready());
  h.pcm("you", Buffer.alloc(32000, 1));
  server.sockets[0].sentence("confirmed before loss");
  server.sockets[0].sentence("you draft", true, 1000, 2);
  server.sockets[1].sentence("other draft", true);
  assert.equal(h.snap().recording.turns.filter(row => row.partial).length, 2);
  server.sockets[0].lose();
  assert.equal(h.snap().recording.connection, "disconnected");
  assert.equal(h.store.readSession(id).jobs.live, "failed");
  assert.deepEqual(Array.from(h.snap().recording.turns, row => row.text), ["confirmed before loss"]);
  h.pcm("you", Buffer.alloc(32000 * 5, 2));
  h.pcm("other", Buffer.alloc(32000 * 6, 3));
  assert.equal(h.invoke("retryRealtime").ok, true);
  assert.equal(h.snap().recording.connection, "reconnecting");
  server.sockets[2].ready();
  assert.equal(h.snap().recording.connection, "reconnecting");
  server.sockets[3].ready();
  assert.equal(h.snap().recording.connection, "connected");
  assert.equal(h.store.readSession(id).jobs.live, "running");
  h.pcm("you", Buffer.alloc(3200, 1));
  server.sockets[2].sentence("confirmed after loss");
  server.sockets[0].sentence("late old connection");
  server.sockets[0].lose();
  const turns = h.snap().recording.turns;
  assert.deepEqual(Array.from(turns, row => row.text), ["confirmed before loss", "confirmed after loss"]);
  assert.equal(turns[1].tStartMs, 6000);
  const persisted = readFileSync(join(h.store.sessionDir(id), "live.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(persisted.map(row => row.text), ["confirmed before loss", "confirmed after loss"]);
  const ending = h.invoke("stop");
  assert.equal(h.invoke("retryRealtime").ok, false);
  assert.equal(server.sockets.length, 4);
  stop.resolve(); await ending;
  assert.equal(readFileSync(join(h.store.sessionDir(id), "mic.wav")).readUInt32LE(40), 195200);
});

test("capture crash during a manual stop persists incomplete once and leaves history untouched", async t => {
  const stop = deferred();
  const h = await launch(t, { stop: () => stop.promise });
  const history = h.store.createRecording();
  h.store.finalize(history.id, "complete", { durationSec: 3 });
  const before = JSON.stringify(h.store.readSession(history.id));
  await h.invoke("start");
  const id = h.snap().recording.sessionId;
  h.pcm("you", Buffer.alloc(32000, 4));
  h.invoke("selectSession", history.id);
  const ending = h.invoke("stop");
  h.crash();
  stop.resolve(); await ending;
  assert.equal(h.store.readSession(id).status, "incomplete");
  assert.equal(JSON.stringify(h.store.readSession(history.id)), before);
  assert.deepEqual(h.calls.queued, [id]);
});

test("failed finalization aborts quit and a recovered retry can close safely", async t => {
  const h = await launch(t);
  await h.invoke("start");
  const id = h.snap().recording.sessionId;
  h.pcm("you", Buffer.alloc(32000, 1));
  const path = join(h.store.sessionDir(id), "session.json");
  chmodSync(path, 0o400);
  t.after(() => { try { chmodSync(path, 0o600); } catch {} });
  h.events.get("before-quit")({ preventDefault() {} });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.calls.quits, 0);
  assert.equal(h.snap().recording.sessionId, id);
  chmodSync(path, 0o600);
  h.events.get("before-quit")({ preventDefault() {} });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.store.readSession(id).status, "complete");
  assert.equal(h.calls.quits, 1);
});


test("quit waiting for failed startup exits after empty recording cleanup without a storage error", async t => {
  const start = deferred();
  const h = await launch(t, { start: () => start.promise });
  const starting = h.invoke('start');
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.calls.starts, 1);
  let prevented = 0;
  h.events.get('before-quit')({ preventDefault() { prevented++; } });
  h.events.get('before-quit')({ preventDefault() { prevented++; } });
  assert.equal(h.calls.quits, 0);
  start.reject(Error('capture permission declined'));
  assert.equal((await starting).ok, false);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(prevented, 2);
  assert.equal(h.snap().recording, null);
  assert.equal(h.snap().capturePhase, 'idle');
  assert.equal(h.store.listSummaries().length, 0);
  assert.equal(h.calls.quits, 1);
  assert.equal(h.calls.errors.length, 0);
});


test("real playback IPC accepts only library media acknowledgements and capture waits for detached audio", async t => {
  const h = await launch(t, { realPlayback: true });
  const history = h.store.createRecording(); h.store.finalize(history.id, 'complete', { durationSec: 30 });
  for (const name of ['mic.wav','system.wav']) {
    const writer = wav.createPcmWavWriter(join(h.store.sessionDir(history.id), name));
    writer.write(Buffer.alloc(30 * 32000, 1)); writer.close();
  }
  h.mediaReady({});
  assert.equal((await h.invoke('playSession', history.id)).ok, false);
  h.mediaReady();
  const playing = h.invoke('playSession', history.id);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const load = h.calls.mediaCommands.at(-1);
  assert.equal(load.action, 'load');
  let resolved = false; void playing.then(() => { resolved = true; });
  const report = { token: load.token, commandId: load.id, status: 'playing', positionSec: 0, ack: true };
  h.mediaReport(report, {});
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(resolved, false);
  h.mediaReport(report); assert.equal((await playing).ok, true);
  h.invoke('selectSession', 'other-history');
  assert.equal(h.snap().playback.sessionId, history.id);
  const starting = h.invoke('start');
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.calls.starts, 0);
  assert.equal(h.snap().capturePhase, 'starting');
  assert.equal(h.snap().recording, null);
  assert.equal(h.store.listSummaries().length, 1);
  const stop = h.calls.mediaCommands.at(-1);
  assert.equal(stop.action, 'stop');
  h.mediaReport({ token: stop.token, commandId: stop.id, status: 'idle', positionSec: 0, ack: true });
  assert.equal((await starting).ok, true);
  assert.equal(h.calls.starts, 1); assert.equal(h.snap().playback, null);
  assert.equal(h.invoke('renameSession', { sessionId: h.snap().recording.sessionId, title: 'cannot rename active' }).ok, false);
  assert.equal(h.invoke('renameSession', { sessionId: history.id, title: 'renamed history during capture' }).ok, true);
  assert.equal(h.invoke('seekPlayback', { sessionId: history.id, positionSec: 10, resume: true }).ok, false);
  await h.invoke('stop');
});

function seedPlayback(h) {
  const doc = h.store.createRecording(); h.store.finalize(doc.id, 'complete', { durationSec: 30 });
  for (const name of ['mic.wav','system.wav']) {
    const writer = wav.createPcmWavWriter(join(h.store.sessionDir(doc.id), name));
    writer.write(Buffer.alloc(30 * 32000, 1)); writer.close();
  }
  return doc.id;
}
async function mediaTick() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function ackMedia(h, status, positionSec = 0) {
  const command = h.calls.mediaCommands.at(-1);
  h.mediaReport({ token: command.token, commandId: command.id, status, positionSec, ack: true });
}

test('actual seek IPC rejects malformed identities and positions without changing a valid playback', async t => {
  const h = await launch(t, { realPlayback: true }); const id = seedPlayback(h); h.mediaReady();
  const p = h.invoke('playSession', id); await mediaTick(); ackMedia(h,'playing',0); await p;
  const active = h.store.createRecording();
  for (const input of [null, {}, {sessionId:'../escape',positionSec:0}, {sessionId:'missing',positionSec:0},
    {sessionId:'00000000-0000-4000-8000-000000000999',positionSec:0}, {sessionId:active.id,positionSec:0},
    ...[undefined,NaN,Infinity,-1,31,'10'].map(positionSec => ({sessionId:id,positionSec})),
    {sessionId:id,positionSec:1,resume:'yes'}]) {
    const count = h.calls.mediaCommands.length, result = await h.invoke('seekPlayback',input);
    assert.equal(result.ok,false,JSON.stringify(input)); assert.ok(result.error.length > 0);
    assert.equal(h.calls.mediaCommands.length,count); assert.equal(h.snap().playback.sessionId,id);
    assert.equal(h.snap().playback.positionSec,0);
  }
  const stop=h.invoke('stopPlayback');await mediaTick();ackMedia(h,'idle');assert.equal((await stop).ok,true);
});

test('real media stop timeout prevents session allocation and capture, then an acknowledged retry can record', async t => {
  const h=await launch(t,{realPlayback:true,mediaTimeout:30});const id=seedPlayback(h);h.mediaReady();
  const p=h.invoke('playSession',id);await mediaTick();ackMedia(h,'playing');await p;
  const result=await h.invoke('start');assert.equal(result.ok,false);
  assert.equal(h.calls.starts,0);assert.equal(h.store.listSummaries().length,1);assert.equal(h.snap().recording,null);
  const retry=h.invoke('start');await mediaTick();assert.equal(h.calls.mediaCommands.at(-1).action,'stop');
  ackMedia(h,'idle');assert.equal((await retry).ok,true);assert.equal(h.calls.starts,1);await h.invoke('stop');
});

test('rename IPC synchronizes disk, list, detail and ongoing playback without changing media position', async t => {
  const h=await launch(t,{realPlayback:true});const id=seedPlayback(h);h.mediaReady();
  const p=h.invoke('playSession',id);await mediaTick();ackMedia(h,'playing',12.5);await p;h.invoke('selectSession',id);
  assert.equal(h.invoke('renameSession',{sessionId:id,title:'  实际改名  '}).ok,true);
  const check = title => {
    assert.equal(h.store.readSession(id).title,title);assert.equal(h.snap().sessions.find(s=>s.id===id).title,title);
    assert.equal(h.snap().selected.title,title);assert.equal(h.snap().playback.title,title);
    assert.equal(h.snap().playback.positionSec,12.5);assert.equal(h.snap().playback.status,'playing');
  };
  check('实际改名');
  for(const title of ['', 'x'.repeat(81), '\n']) {const result=h.invoke('renameSession',{sessionId:id,title});assert.equal(result.ok,false);assert.ok(result.error);check('实际改名');}
  const stop=h.invoke('stopPlayback');await mediaTick();ackMedia(h,'idle');await stop;
});

test('export IPC returns a saved location and only reveals a capability issued after successful writing', async t => {
  let path, canceled=false;
  const h=await launch(t,{save:async()=>({canceled,filePath:path})});const id=seedPlayback(h);
  h.store.patchJobs(id,{refined:{status:'idle'}});
  const fs=await import('node:fs'); fs.writeFileSync(join(h.store.sessionDir(id),'live.jsonl'),JSON.stringify({id:'t',track:'other',speaker:'小 A',tStartMs:0,text:'导出核对'})+'\n');
  path=join(h.store.rootDir,'..','result.txt');
  const result=await h.invoke('exportTranscript',{sessionId:id,format:'txt'});
  assert.equal(result.ok,true);assert.equal(result.saved.path,fs.realpathSync(path));assert.match(result.saved.id,/^[0-9a-f-]{36}$/);
  assert.match(readFileSync(path,'utf8'),/导出核对/);
  assert.equal(h.invoke('revealExport',path).ok,false);assert.equal(h.invoke('revealExport','unknown').ok,false);
  assert.deepEqual(h.calls.revealed,[]);assert.equal(h.invoke('revealExport',result.saved.id).ok,true);assert.deepEqual(h.calls.revealed,[result.saved.path]);
  canceled=true;const cancel=await h.invoke('exportTranscript',{sessionId:id,format:'json'});
  assert.equal(cancel.canceled,true);assert.equal(cancel.saved,undefined);
});

const createSessionStore = sessions.createSessionStore;
const createPcmWavWriter = wav.createPcmWavWriter;
/**
 * A timestamp request must play the requested session at that position, including across queued switches.
 */

const seekRequire = createRequire(import.meta.url);
const seekCompiled = ts.transpileModule(readFileSync(new URL('./index.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
// Load production collaborators unchanged; only Electron/capture/window boundaries are controlled.
const seekProductionModules = Object.fromEntries(await Promise.all([
  './capture/permissions', './capture/screen-status', './jobs/orchestrate', './store/key',
  './live', './playback', './live-transcriber', './store/sessions', './store/snapshot',
  './store/wav', './voiceprint/enroll', './speaker-names', './export', './windows/navigation', './recording-actions',
].map(async name => [name, await import(`${name}.ts`)])));

async function launchQueuedSeek(t) {
  const root = mkdtempSync(join(tmpdir(), 'earshot-seek-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(join(root, 'Earshot'));
  function recording(sample) {
    const doc = store.createRecording();
    for (const name of ['mic.wav', 'system.wav']) {
      const writer = createPcmWavWriter(join(store.sessionDir(doc.id), name));
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
  const handlers = new Map(), protocols = new Map(), windows = [], errors = [];
  let ready, holdNext = null, held = null;
  let media = { token: null, url: null, positionSec: 0, status: 'idle' };
  const trace = [];
  function acknowledge(command) {
    if (command.action === 'load') media = {
      token: command.token, url: command.url, positionSec: command.positionSec ?? 0, status: 'playing',
    };
    else {
      assert.equal(command.token, media.token, 'media commands must address the attached source');
      if (command.action === 'seek') {
        media.positionSec = command.positionSec;
        if (command.resume) media.status = 'playing';
      } else if (command.action === 'pause') media.status = 'paused';
      else if (command.action === 'resume') media.status = 'playing';
      else if (command.action === 'stop') media.status = 'idle';
      else throw new Error(`Unsupported media action: ${command.action}`);
    }
    trace.push({ action: command.action, token: command.token, positionSec: media.positionSec });
    handlers.get('app:playbackReport')({ sender: windows[0].webContents }, {
      token: command.token, commandId: command.id, status: media.status,
      positionSec: media.positionSec, ack: true,
    });
  }
  class Window {
    visible = false;
    webContents = {
      on() {}, getURL: () => 'local',
      send(name, command) {
        if (name !== 'earshot:playback') return;
        if (holdNext) {
          held = command;
          const resolve = holdNext; holdNext = null; resolve();
        } else acknowledge(command);
      },
    };
    constructor() { windows.push(this); }
    on() {}
    isDestroyed() { return false; }
    isVisible() { return this.visible; }
    center() {}
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    static getAllWindows() { return windows; }
  }
  const boundaryModules = {
    electron: {
      app: { setName() {}, commandLine: { appendSwitch() {} }, getAppPath: () => root,
        getPath: () => root, isReady: () => true, on() {},
        whenReady: () => ({ then: fn => { ready = fn(); } }),
      },
      BrowserWindow: Window,
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => handlers.set(name, fn) },
      protocol: { registerSchemesAsPrivileged() {}, handle: (name, fn) => protocols.set(name, fn) },
      globalShortcut: { register: () => true, unregister() {} }, powerMonitor: { on() {}, removeListener() {} },
      systemPreferences: { getMediaAccessStatus: () => 'granted', isTrustedAccessibilityClient: () => false },
      dialog: { showErrorBox: (...args) => errors.push(args) }, shell: {},
    },
    './capture/screen': { installScreenPicker() {}, probeScreenPermission: () => 'granted' },
    './capture/runtime': { startCapture() { throw new Error('Capture is outside this playback scenario'); } },
    './windows/library': { createLibraryWindow: () => new Window() },
    './windows/glance': { createGlanceWindow: () => new Window() },
    './windows/load': { loadRenderer() {} },
  };
  const loadSource = sourceLoader(fileURLToPath(new URL("./index.ts", import.meta.url)), { ...seekProductionModules, ...boundaryModules, "./dictation/macos": { createMacDictationBridge: () => undefined } });
  runInNewContext(seekCompiled, {
    exports: {}, require: name => {
      if (name.startsWith('node:')) return seekRequire(name);
      const module = boundaryModules[name] ?? seekProductionModules[name];
      return module ?? loadSource(name);
    },
    console: { log() {}, error: (...args) => errors.push(args) }, process, setTimeout, clearTimeout,
  });
  await ready;
  assert.deepEqual(errors, [], 'main initialization must succeed');
  const sender = windows[0].webContents;
  handlers.get('app:playbackHost')({ sender }, true);
  t.after(() => handlers.get('app:playbackHost')({ sender }, false));
  return {
    a, b, trace,
    invoke: (name, input) => handlers.get(`app:${name}`)({ sender }, input),
    snapshot: () => handlers.get('app:snapshot')({ sender }),
    holdNextAcknowledgement() {
      const arrival = Promise.withResolvers(); holdNext = arrival.resolve;
      return arrival.promise;
    },
    releaseAcknowledgement() { const command = held; held = null; acknowledge(command); },
    async mediaOutcome() {
      const offset = 44 + media.positionSec * 16000 * 2;
      const response = protocols.get('earshot-audio')(new Request(media.url, {
        headers: { Range: `bytes=${offset}-${offset + 1}` },
      }));
      assert.equal(response.status, 206, 'active audio must be readable at the final playback position');
      return { positionSec: media.positionSec, sample: Buffer.from(await response.arrayBuffer()).readInt16LE(0) };
    },
  };
}

async function seekAfterPendingAcknowledgement(t, crossover) {
  const h = await launchQueuedSeek(t);
  assert.equal((await h.invoke('playSession', h.a)).ok, true);
  const arrived = h.holdNextAcknowledgement();
  const firstSeek = h.invoke('seekPlayback', { sessionId: h.a, positionSec: 3, resume: true });
  await arrived;
  assert.equal(h.snapshot().playback.sessionId, h.a, 'A must own playback while its acknowledgement is held');
  const switchToB = crossover ? h.invoke('playSession', h.b) : null;
  const targetSeek = h.invoke('seekPlayback', { sessionId: h.a, positionSec: 12, resume: true });
  h.releaseAcknowledgement();
  const results = await Promise.all([firstSeek, ...(switchToB ? [switchToB] : []), targetSeek]);
  assert.deepEqual(results.map(result => result.ok), crossover ? [true, true, true] : [true, true]);
  const playback = h.snapshot().playback;
  const outcome = {
    sessionId: playback.sessionId, positionSec: playback.positionSec, status: playback.status,
    media: await h.mediaOutcome(),
  };
  t.diagnostic(JSON.stringify({ a: h.a, b: h.b, results, outcome, mediaCommands: h.trace }));
  return { outcome, expected: { sessionId: h.a, positionSec: 12, status: 'playing',
    media: { positionSec: 12, sample: 1000 } } };
}

test('timestamp seek retains requested session A across a queued play of B', async t => {
  const { outcome, expected } = await seekAfterPendingAcknowledgement(t, true);
  assert.deepEqual(outcome, expected, 'timestamp seek must play session A audio at 12 seconds');
});

test('timestamp seek retains session A without a queued session switch', async t => {
  const { outcome, expected } = await seekAfterPendingAcknowledgement(t, false);
  assert.deepEqual(outcome, expected, 'timestamp seek must play session A audio at 12 seconds');
});


test('queued pause cannot pause a different session and queued play uses a freshly renamed title', async t => {
  const h = await launchQueuedSeek(t);
  assert.equal((await h.invoke('playSession', h.a)).ok, true);
  const arrived = h.holdNextAcknowledgement();
  const seek = h.invoke('seekPlayback', {sessionId:h.a, positionSec:3, resume:true});
  await arrived;
  const next = h.invoke('playSession',h.b);
  const pause = h.invoke('pausePlayback',h.a);
  assert.equal(h.invoke('renameSession',{sessionId:h.b,title:'Queued B renamed'}).ok,true);
  h.releaseAcknowledgement();
  assert.equal((await seek).ok,true); assert.equal((await next).ok,true);
  assert.equal((await pause).ok,false);
  const state=h.snapshot().playback;
  assert.equal(state.sessionId,h.b); assert.equal(state.status,'playing');
  assert.equal(state.title,'Queued B renamed');
  assert.equal((await h.mediaOutcome()).sample,2000);
});

test('session IPC rejects path traversal without changing selection or starting a job', async t => {
  const h=await launch(t);const doc=h.store.createRecording();h.store.finalize(doc.id,'complete');
  h.invoke('selectSession',doc.id);const selected=h.snap().selectedId;
  h.invoke('selectSession','../../outside');assert.equal(h.snap().selectedId,selected);
  assert.equal(h.invoke('retryJob',{sessionId:'../../outside',job:'refined'}).ok,false);
  assert.equal(h.invoke('cancelJob','../../outside').ok,false);
});

test('auto diarization IPC accepts booleans and ignores malformed values', async t => {
  const h=await launch(t);
  for(const initial of [false,true]) {
    h.invoke('setAutoDiarize',initial);assert.equal(h.snap().autoDiarize,initial);
    for(const invalid of ['false',1,0,null,undefined,{}]) {
      h.invoke('setAutoDiarize',invalid);assert.equal(h.store.readPrefs().autoDiarize,initial);
    }
  }
});
