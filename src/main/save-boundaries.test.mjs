import { trayFixture } from "../../scripts/electron-tray-fixture.mjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

/** Real source modules, with doubles only at Electron, OS and network boundaries. */
async function launch(t, existingRoot) {
  const root = existingRoot ?? fs.mkdtempSync(join(tmpdir(), "earshot-c3-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const windows = [];
  const sockets = [];
  let keyAvailable = !existingRoot;
  let fault = null;
  let clock = Date.parse("2026-09-07T00:00:00.000Z");
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  let quits = 0;
  let faultWrites = 0;
  let committedBeforeFault = null;
  const timers = new Set();
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  class Socket {
    listeners = new Map();
    constructor() { sockets.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    send() {}
    destroy() { this.destroyed = true; this.visible = false; this.emit("closed"); }
    close() {}
    message(body) { this.listeners.get("message")?.({ data: JSON.stringify(body) }); }
    ready() { this.message({ header: { event: "task-started" } }); }
    sentence(text) {
      this.message({ header: { event: "result-generated" }, payload: { output: {
        sentence: { sentence_id: 1, text, begin_time: 0, sentence_end: true },
      } } });
    }
  }
  const handlers = new Map();
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  ipcMain.removeHandler = name => handlers.delete(name);
  let captureLoaded = deferred();
  class Window extends EventEmitter {
    visible = false;
    destroyed = false;
    surface = null;
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      send() {}, getURL: () => this.url ?? "",
    });
    constructor(options) { super(); this.visible = options.show !== false; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return !this.destroyed && this.visible; }
    center() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    focus() {}
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.visible = false; this.emit("closed"); }
    close() {
      let prevented = false;
      this.emit("close", { preventDefault() { prevented = true; } });
      if (!prevented) {
        this.destroyed = true;
        this.visible = false;
        this.emit("closed");
      }
    }
    async loadFile(path, options = {}) {
      this.url = path;
      this.surface = path.endsWith("/dictation-capture.html") ? "dictation-capture" : path.endsWith("/capture.html") ? "capture" : options.hash || "library";
      this.webContents.emit("did-finish-load");
      if (this.surface === "capture") captureLoaded.resolve(this);
    }
    async loadURL(url) {
      const parsed = new URL(url);
      return this.loadFile(parsed.pathname, { hash: parsed.hash.slice(1) });
    }
    static getAllWindows() { return windows.filter(win => !win.isDestroyed()); }
  }
  let ready;
  const app = Object.assign(new EventEmitter(), {
    setName() {}, commandLine: { appendSwitch() {} },
    getAppPath: () => root, getPath: () => root, isReady: () => true,
    whenReady: () => ({ then: fn => { ready = fn(); } }),
    quit() { quits++; },
  });
  const electron = { ...trayFixture(),
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    app, BrowserWindow: Window, ipcMain, dialog: { showErrorBox() {} }, shell: {},
    nativeTheme: { shouldUseDarkColors: false },
    globalShortcut: { register: () => true, unregister() {} }, powerMonitor: new EventEmitter(),
    systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => false },
    desktopCapturer: { getSources: async () => [{ id: "screen:fixture" }] },
    session: { defaultSession: {
      setPermissionRequestHandler() {}, setDisplayMediaRequestHandler() {},
    } },
  };
  // No real key is read or written. All session/WAV IO remains real in the test temp root.
  const filesystem = { ...fs, readFileSync(path, ...args) {
    if (path === join(root, "Earshot", "key")) return keyAvailable ? "fixture-only-not-a-key" : "";
    return fs.readFileSync(path, ...args);
  }, writeFileSync(path, data, options) {
    // Inject an OS write failure at a metadata write, including a future temp-file
    // commit path. Never replace a store/orchestration/transcriber function.
    if (fault && !fault.mode.startsWith("rename-") && typeof path === "string" && dirname(path) === fault.dir) {
      let doc;
      try { doc = JSON.parse(String(data)); } catch {}
      if (doc?.id === fault.id && (doc.status === "complete" || (fault.mode === "startup-save" && doc.status === "incomplete")) && (fault.mode === "startup-save" || fault.mode === "first-write" || fault.mode === "partial-first" || ++faultWrites >= 2)) {
        committedBeforeFault = fs.readFileSync(join(fault.dir, "session.json"), "utf8");
        if (fault.mode === "after-truncate" || fault.mode === "partial-first") {
          const fd = fs.openSync(path, "w");
          try { fs.writeSync(fd, String(data).slice(0, 12)); }
          finally { fs.closeSync(fd); }
        }
        throw Object.assign(new Error("fixture metadata write EIO"), { code: "EIO" });
      }
    }
    return fs.writeFileSync(path, data, options);
  }, rmSync(path, options) {
    if (fault?.mode === "startup-empty" && path === fault.dir) throw Object.assign(new Error("fixture cleanup EIO"), { code: "EIO" });
    return fs.rmSync(path, options);
  }, renameSync(source, destination) {
    if (fault?.mode.startsWith("rename-") && destination === join(fault.dir, "session.json") &&
        ++faultWrites >= (fault.mode === "rename-second" ? 2 : 1)) {
      const doc = JSON.parse(fs.readFileSync(source, "utf8"));
      assert.equal(doc.status, "complete", "temporary document is complete before commit fails");
      committedBeforeFault = fs.readFileSync(destination, "utf8");
      throw Object.assign(new Error("fixture rename EIO"), { code: "EIO" });
    }
    return fs.renameSync(source, destination);
  } };
  const nativePermissions = { getAuthStatus: () => "authorized" };
  const modules = new Map();
  const context = createContext({
    console, process, Buffer, Uint8Array, Error, URL, AbortController, setInterval, clearInterval, ArrayBuffer, Date: Clock,
    setTimeout(fn, ms, ...args) {
      const timer = setTimeout(() => { timers.delete(timer); fn(...args); }, ms);
      timers.add(timer);
      return timer;
    }, clearTimeout,
    WebSocket: Socket,
    fetch() { throw new Error("Network disabled in capture fixture"); },
  });
  function load(filename) {
    // Native accessibility is an OS boundary; recording tests must not query the host desktop.
    if (filename.endsWith("/dictation/macos.ts")) return { createMacDictationBridge: () => undefined };
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      // Preserve import.meta.url semantics when loading TS as in-memory CommonJS.
      transformers: { before: [ctx => source => {
        function visit(node) {
          if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
            return ts.factory.createObjectLiteralExpression([
              ts.factory.createPropertyAssignment("url", ts.factory.createStringLiteral(pathToFileURL(filename).href)),
            ]);
          }
          return ts.visitEachChild(node, visit, ctx);
        }
        return ts.visitNode(source, visit);
      }] },
    }).outputText;
    const localRequire = name => {
      if (name === "electron") return electron;
      if (name === "node:fs") return filesystem;
      if (name === "node:module") return { ...require(name), createRequire: url => {
        const nativeRequire = createRequire(url);
        return id => id === "node-mac-permissions" ? nativePermissions : nativeRequire(id);
      } };
      if (name.startsWith("node:")) return require(name);
      if (name.startsWith(".")) {
        const target = resolve(dirname(filename), name);
        return load(extname(target) ? target : `${target}.ts`);
      }
      throw new Error(`Unexpected external dependency: ${name}`);
    };
    runInContext(`(function(require,module,exports,__dirname){${compiled}\n})`, context, { filename })(
      localRequire, module, module.exports, dirname(filename),
    );
    return module.exports;
  }
  load(entry);
  await ready;
  const library = windows.find(win => win.surface === "library");
  assert.equal(library?.isVisible(), true, "entry opens the library");
  const invoke = (name, raw) => handlers.get(`app:${name}`)({}, raw);
  return {
    root, invoke, get quits() { return quits; }, get committedBeforeFault() { return committedBeforeFault; },
    advance(ms) { clock += ms; },
    disconnect() { sockets.forEach(socket => socket.listeners.get("close")?.({})); },
    async startPending() {
      captureLoaded = deferred();
      const starting = invoke("start");
      const win = await captureLoaded.promise;
      return { starting, win };
    },
    rejectCapture(win) { ipcMain.emit("capture:failed", { sender: win.webContents }, "capture failed"); },
    async start() {
      captureLoaded = deferred();
      const starting = invoke("start");
      const win = await captureLoaded.promise;
      ipcMain.emit("capture:ready", { sender: win.webContents });
      assert.equal((await starting).ok, true);
      sockets.forEach(socket => socket.ready());
      assert.equal(invoke("snapshot").recording.connection, "connected");
      return win;
    },
    pcm(win, track, bytes) { for (let offset = 0; offset < bytes.length; offset += 8192) ipcMain.emit("capture:pcm", { sender: win.webContents }, track, bytes.subarray(offset, offset + 8192)); },
    transcript() { sockets[0].sentence("confirmed before save failure"); },
    failMetadata(id, mode) { fault = { id, mode, dir: join(root, "Earshot", "sessions", id) }; },
    restoreWrites() { fault = null; },
    // Simulate the credential file becoming unavailable after recording starts,
    // identically in both scenarios, so no cloud post-processing is scheduled.
    removeCredential() { keyAvailable = false; },
    quitPrevented() {
      let prevented = false;
      app.emit("before-quit", { preventDefault() { prevented = true; } });
      return prevented;
    },
  };
}

for (const failSecondWrite of [true, false]) {
  test(`quit after finalizing metadata ${failSecondWrite ? 'retains ownership when job-state write fails' : 'closes after both writes succeed'}`, async t => {
    const h = await launch(t);
    const capture = await h.start();
    const id = h.invoke('snapshot').recording.sessionId;
    h.pcm(capture, 'you', Buffer.alloc(32000, 1));
    h.pcm(capture, 'other', Buffer.alloc(32000, 2));
    h.transcript();
    if (failSecondWrite) h.failMetadata(id, 'before-open');
    assert.equal(h.quitPrevented(), true);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const path = join(h.root, 'Earshot', 'sessions', id, 'session.json');
    assert.equal(JSON.parse(fs.readFileSync(path, 'utf8')).status, 'complete');
    if (failSecondWrite) {
      assert.equal(h.quits, 0, 'later persistence failure must keep the app open');
      assert.equal(h.invoke('snapshot').capturePhase, 'finalize_failed');
      assert.equal(h.invoke('snapshot').recording.sessionId, id);
      h.restoreWrites();
      assert.equal(h.quitPrevented(), true);
      for (let i = 0; i < 30; i++) await Promise.resolve();
    }
    assert.equal(h.quits, 1);
    assert.equal(h.invoke('snapshot').recording, null);
    const doc = JSON.parse(fs.readFileSync(path, 'utf8'));
    assert.equal(doc.jobs.refined.status, 'failed');
    assert.equal(doc.jobs.speakers.status, 'failed');
    assert.equal(doc.status, 'complete');
  });
}

const saveSnapshots = {};
for (const variant of ['empty', 'transcript', 'disconnected']) {
  test(`real failed-save snapshot remains stopped through navigation and retry (${variant})`, async t => {
    const h = await launch(t);
    const capture = await h.start();
    const id = h.invoke('snapshot').recording.sessionId;
    h.pcm(capture, 'you', Buffer.alloc(60 * 32000, 1));
    h.pcm(capture, 'other', Buffer.alloc(60 * 32000, 2));
    if (variant === 'transcript') h.transcript();
    if (variant === 'disconnected') h.disconnect();
    h.advance(60000);
    h.removeCredential();
    h.failMetadata(id, 'first-write');
    assert.equal((await h.invoke('stop')).ok, false);
    const failed = h.invoke('snapshot');
    assert.equal(failed.recording.phase, 'finalize_failed');
    assert.equal(failed.recording.elapsedSec, 60);
    h.advance(600000);
    h.invoke('selectSession', 'history');
    h.invoke('showLibrary');
    const restored = h.invoke('snapshot');
    assert.equal(restored.selectedId, id);
    assert.equal(restored.recording.elapsedSec, 60);
    assert.equal(restored.selected.durationSec, 60);
    assert.equal(restored.sessions.find(s => s.id === id).durationSec, 60);
    h.restoreWrites();
    assert.equal((await h.invoke('stop')).ok, true);
    const saved = h.invoke('snapshot');
    assert.equal(saved.recording, null);
    assert.equal(saved.capturePhase, 'idle');
    assert.equal(saved.selected.durationSec, 60);
    assert.equal(saved.selected.endedAt, '2026-09-07T00:01:00.000Z');
    saveSnapshots[variant] = { failed, restored, saved };
  });
}
after(() => {
  if (process.env.EARSHOT_SAVE_SNAPSHOT_OUTPUT) {
    fs.writeFileSync(process.env.EARSHOT_SAVE_SNAPSHOT_OUTPUT, JSON.stringify(saveSnapshots, null, 2) + '\n');
  }
});

for (const mode of ['partial-first', 'rename-first', 'rename-second']) {
  test(`atomic metadata commit preserves the last readable document and recovers (${mode})`, async t => {
    const h = await launch(t);
    const capture = await h.start();
    const id = h.invoke('snapshot').recording.sessionId;
    const dir = join(h.root, 'Earshot', 'sessions', id), path = join(dir, 'session.json');
    for (const track of ['you', 'other']) h.pcm(capture, track, Buffer.alloc(60 * 32000, 3));
    h.transcript(); h.advance(60000); h.removeCredential(); h.failMetadata(id, mode);
    if (mode === 'rename-second') {
      assert.equal(h.quitPrevented(), true);
      for (let i = 0; i < 30; i++) await Promise.resolve();
    } else assert.equal((await h.invoke('stop')).ok, false);
    assert.equal(h.quits, 0);
    const metadata = fs.readFileSync(path, 'utf8');
    assert.equal(metadata, h.committedBeforeFault, 'the last committed bytes survive the failed write or rename');
    assert.equal(JSON.parse(metadata).id, id);
    assert.deepEqual(fs.readdirSync(dir).filter(file => file.endsWith('.tmp')), []);
    assert.equal(h.invoke('snapshot').recording.sessionId, id);
    assert.equal(h.invoke('snapshot').capturePhase, 'finalize_failed');
    assert.equal((await h.invoke('start')).ok, false);
    const originals = ['mic.wav', 'system.wav', 'live.jsonl'].map(file => fs.readFileSync(join(dir, file)));
    h.advance(600000); h.restoreWrites();
    // Also covers switching from a failed quit to an explicit manual save retry.
    assert.equal((await h.invoke('stop')).ok, true);
    assert.equal(h.invoke('snapshot').recording, null);
    const saved = JSON.parse(fs.readFileSync(path, 'utf8'));
    assert.equal(saved.status, 'complete'); assert.equal(saved.durationSec, 60);
    assert.equal(saved.endedAt, '2026-09-07T00:01:00.000Z');
    for (const [i, file] of ['mic.wav', 'system.wav', 'live.jsonl'].entries()) assert.deepEqual(fs.readFileSync(join(dir, file)), originals[i]);
    const reopened = await launch(t, h.root);
    assert.equal(reopened.invoke('snapshot').selected.id, id);
    assert.deepEqual(Array.from(reopened.invoke('snapshot').selected.turns, turn => turn.text), ['confirmed before save failure']);
  });
}

for (const hasAudio of [false, true]) {
  test(`quit waiting for startup cleanup failure retains recovery (${hasAudio ? 'existing audio' : 'empty directory'})`, async t => {
    const h = await launch(t);
    const { starting, win } = await h.startPending();
    const id = h.invoke('snapshot').recording.sessionId;
    const dir = join(h.root, 'Earshot', 'sessions', id);
    const pcm = { 'mic.wav': Buffer.alloc(17 * 32000, 4), 'system.wav': Buffer.alloc(31 * 32000, 5) };
    if (hasAudio) { h.pcm(win, 'you', pcm['mic.wav']); h.pcm(win, 'other', pcm['system.wav']); }
    h.advance(60000); h.removeCredential();
    h.failMetadata(id, hasAudio ? 'startup-save' : 'startup-empty');
    assert.equal(h.quitPrevented(), true);
    h.rejectCapture(win);
    assert.equal((await starting).ok, false);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(h.quits, 0);
    assert.equal(h.invoke('snapshot').capturePhase, 'finalize_failed');
    assert.equal(h.invoke('snapshot').recording.sessionId, id);
    assert.equal((await h.invoke('start')).code, 'busy');
    assert.equal(JSON.parse(fs.readFileSync(join(dir, 'session.json'), 'utf8')).status, 'recording');
    h.restoreWrites(); h.advance(600000);
    assert.equal(h.quitPrevented(), true);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(h.quits, 1);
    assert.equal(h.invoke('snapshot').recording, null);
    assert.equal(h.invoke('snapshot').capturePhase, 'idle');
    if (hasAudio) {
      const doc = JSON.parse(fs.readFileSync(join(dir, 'session.json'), 'utf8'));
      assert.equal(doc.status, 'incomplete'); assert.equal(doc.durationSec, 31);
      assert.equal(doc.endedAt, '2026-09-07T00:01:00.000Z');
      for (const name of ['mic.wav','system.wav']) assert.deepEqual(fs.readFileSync(join(dir, name)).subarray(44), pcm[name]);
    } else {
      assert.equal(fs.existsSync(dir), false);
      assert.equal(h.invoke('snapshot').sessions.length, 0);
    }
  });
}
