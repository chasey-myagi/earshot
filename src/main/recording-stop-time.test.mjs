// Time spent waiting for a failed save does not extend recording duration. A 60-second capture remains 60 seconds after a delayed persistence retry.
import assert from "node:assert/strict";
import { test } from "node:test";
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
async function launch(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "earshot-c4-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse("2026-09-07T00:00:00.000Z");
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const windows = [];
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
    focus() {}
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
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
      this.surface = path.endsWith("capture.html") ? "capture" : options.hash || "library";
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
    quit() {},
  });
  const electron = {
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    app, BrowserWindow: Window, ipcMain, dialog: {}, shell: {},
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
    if (path === join(root, "Earshot", "key")) return "fixture-only-not-a-key";
    return fs.readFileSync(path, ...args);
  } };
  const nativePermissions = { getAuthStatus: () => "authorized" };
  const modules = new Map();
  const context = createContext({
    console, process, Buffer, Uint8Array, Error, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, Date: FixtureDate,
    WebSocket: class { constructor() { throw new Error("Network disabled in capture fixture"); } },
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
  const invoke = name => handlers.get(`app:${name}`)({});
  t.after(async () => {
    if (invoke("snapshot").capturePhase === "recording") {
      app.emit("before-quit", { preventDefault() {} });
      await invoke("stop");
    }
  });
  return {
    library, invoke,
    advance(ms) { now += ms; },
    sessionPath(id) { return join(root, "Earshot", "sessions", id, "session.json"); },
    pcm(win, track, bytes) {
      for (let offset = 0; offset < bytes.length; offset += 8192) ipcMain.emit("capture:pcm", { sender: win.webContents }, track, bytes.subarray(offset, offset + 8192));
    },
    async startPending() {
      captureLoaded = deferred();
      const starting = invoke("start");
      const captureWindow = await captureLoaded.promise;
      assert.equal(invoke("snapshot").capturePhase, "starting");
      assert.equal(typeof invoke("snapshot").recording?.sessionId, "string");
      return { starting, captureWindow };
    },
    rejectCapture(win) { ipcMain.emit("capture:failed", { sender: win.webContents }, "麦克风采集被拒绝"); },
    acceptCapture(win) { ipcMain.emit("capture:ready", { sender: win.webContents }); },
    visibility() {
      return {
        libraryVisible: library.isVisible(),
        glanceVisible: windows.some(win => win.surface === "glance" && win.isVisible()),
      };
    },
  };
}

const startedAt = "2026-09-07T00:00:00.000Z";
const stoppedAt = "2026-09-07T00:01:00.000Z";

async function recordAndRetry(t, waitMs) {
  const h = await launch(t);
  const { starting, captureWindow } = await h.startPending();
  h.acceptCapture(captureWindow);
  assert.equal((await starting).ok, true);
  const id = h.invoke("snapshot").recording.sessionId;
  const path = h.sessionPath(id);
  const readSession = () => JSON.parse(fs.readFileSync(path, "utf8"));
  assert.equal(readSession().startedAt, startedAt);
  const bodies = { "mic.wav": Buffer.alloc(16000 * 2 * 60, 1),
    "system.wav": Buffer.alloc(16000 * 2 * 60, 2) };
  h.pcm(captureWindow, "you", bodies["mic.wav"]);
  h.pcm(captureWindow, "other", bodies["system.wav"]);
  h.advance(60_000);
  assert.equal(h.invoke("snapshot").recording.elapsedSec, 60);

  fs.chmodSync(path, 0o400);
  t.after(() => { if (fs.existsSync(path)) fs.chmodSync(path, 0o600); });
  assert.equal((await h.invoke("stop")).ok, false, "read-only session causes saving to fail");
  assert.equal(h.invoke("snapshot").capturePhase, "finalize_failed");
  assert.equal(captureWindow.isDestroyed(), true, "capture has ended before the save retry wait");
  assert.equal(readSession().status, "recording", "unsaved session remains on disk");
  const before = Object.fromEntries(Object.keys(bodies).map(name =>
    [name, fs.readFileSync(join(dirname(path), name))]));
  h.advance(waitMs);
  const failed = h.invoke("snapshot");
  assert.equal(failed.capturePhase, "finalize_failed");
  assert.equal(failed.recording.sessionId, id);
  fs.chmodSync(path, 0o600);
  assert.equal((await h.invoke("stop")).ok, true, "retry saves after permissions recover");
  // Let the real post-processing chain handle the disabled network boundary before cleanup.
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.invoke("snapshot").capturePhase, "idle");
  assert.equal(h.invoke("snapshot").recording, null);
  const saved = readSession();
  assert.equal(saved.status, "complete");
  for (const [name, body] of Object.entries(bodies)) {
    const bytes = fs.readFileSync(join(dirname(path), name));
    assert.deepEqual(bytes, before[name], "retry must preserve the stopped WAV: " + name);
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.readUInt32LE(4), bytes.length - 8);
    assert.equal(bytes.readUInt16LE(22), 1);
    assert.equal(bytes.readUInt32LE(24), 16000);
    assert.equal(bytes.readUInt16LE(34), 16);
    assert.equal(bytes.readUInt32LE(40), body.length);
    assert.equal(bytes.length, body.length + 44);
    assert.deepEqual(bytes.subarray(44), body);
    assert.equal(bytes.readUInt32LE(40) / bytes.readUInt32LE(28), 60);
  }
  const observed = {
    failedSnapshotElapsedSec: failed.recording.elapsedSec,
    failedListDurationSec: failed.sessions.find(row => row.id === id).durationSec,
    failedDetailDurationSec: failed.selected.durationSec,
    savedDurationSec: saved.durationSec,
    savedEndedAt: saved.endedAt,
  };
  t.diagnostic(JSON.stringify({ waitMs, wavSeconds: [60, 60], ...observed }));
  return observed;
}

const expected = {
  failedSnapshotElapsedSec: 60,
  failedListDurationSec: 60,
  failedDetailDurationSec: 60,
  savedDurationSec: 60,
  savedEndedAt: stoppedAt,
};

test("C4: delayed save retry preserves the stopped recording timeline", { timeout: 10_000 }, async t => {
  const observed = await recordAndRetry(t, 600_000);
  assert.deepEqual(observed, expected,
    "saving delays must not extend the stopped recording's snapshot or persisted timeline");
});

test("control: immediate save retry preserves the stopped recording timeline", { timeout: 10_000 }, async t => {
  const observed = await recordAndRetry(t, 0);
  assert.deepEqual(observed, expected);
});
