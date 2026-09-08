import { trayFixture } from "../../scripts/electron-tray-fixture.mjs";
// Metadata IO failure must not escape a WebSocket event or suppress connection notifications. Audio capture and save retry survive.
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

/** Run the main entry and all local modules; doubles stop at Electron/OS/WebSocket. */
async function launch(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "earshot-live-status-io-"));
  const windows = [], sockets = [], timers = new Set();
  const handlers = new Map();
  let ready, invoke, captureLoaded = deferred();
  let keyAvailable = true, metadataPath = null, metadataFault = null;
  t.after(async () => {
    metadataFault = null;
    keyAvailable = false;
    if (metadataPath && fs.existsSync(metadataPath)) fs.chmodSync(metadataPath, 0o600);
    try { await invoke?.("stop"); }
    finally {
      for (const timer of timers) clearTimeout(timer);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  class Socket {
    listeners = new Map();
    constructor() { sockets.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    send() {}
    destroy() { this.destroyed = true; this.visible = false; this.emit("closed"); }
    close() {}
    ready() {
      this.listeners.get("open")?.({});
      this.listeners.get("message")?.({ data: JSON.stringify({ header: { event: "task-started" } }) });
    }
    disconnect() { this.listeners.get("close")?.({}); }
    deny() { this.listeners.get("message")?.({ data: JSON.stringify({header: {event: "task-failed", error_code: "InvalidApiKey"}}) }); }
  }
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  ipcMain.removeHandler = name => handlers.delete(name);
  class Window extends EventEmitter {
    visible = false;
    destroyed = false;
    surface = null;
    notifications = [];
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      send: channel => {
        if (channel === "earshot:changed" && invoke) {
          // Observe the renderer's public change event and subsequent snapshot IPC.
          this.notifications.push(invoke("snapshot").recording?.connection ?? null);
        }
      },
      getURL: () => this.url ?? "",
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
  const app = Object.assign(new EventEmitter(), {
    setName() {}, commandLine: { appendSwitch() {} },
    getAppPath: () => root, getPath: () => root, isReady: () => true,
    whenReady: () => ({ then: fn => { ready = fn(); } }), quit() {},
  });
  const electron = { ...trayFixture(),
    app, BrowserWindow: Window, ipcMain, dialog: { showErrorBox() {} }, shell: {},
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    nativeTheme: { shouldUseDarkColors: false },
    globalShortcut: { register: () => true, unregister() {} }, powerMonitor: new EventEmitter(),
    systemPreferences: { getMediaAccessStatus: () => "granted", isTrustedAccessibilityClient: () => false },
    desktopCapturer: { getSources: async () => [{ id: "screen:fixture" }] },
    session: { defaultSession: {
      setPermissionRequestHandler() {}, setDisplayMediaRequestHandler() {},
    } },
  };
  const filesystem = {
    ...fs,
    readFileSync(path, ...args) {
      if (path === join(root, "Earshot", "key")) return keyAvailable ? "fixture-only-not-a-key" : "";
      return fs.readFileSync(path, ...args);
    },
    writeFileSync(path, ...args) {
      // Fail only session metadata at the filesystem boundary, including atomic
      // temporary-file writes. Real store, transcriber and capture code stay intact.
      if (metadataFault === "EIO" && typeof path === "string" &&
          (path === metadataPath || path.startsWith(`${metadataPath}.`))) {
        throw Object.assign(new Error("fixture session metadata write EIO"), { code: "EIO" });
      }
      return fs.writeFileSync(path, ...args);
    },
  };
  const modules = new Map();
  const context = createContext({
    console: { log() {}, error() {} }, process, Buffer, Uint8Array, Error, URL, AbortController, ArrayBuffer,
    setTimeout(fn, ms, ...args) {
      const timer = setTimeout(() => { timers.delete(timer); fn(...args); }, ms);
      timers.add(timer);
      return timer;
    }, clearTimeout, setInterval, clearInterval, WebSocket: Socket,
    fetch() { throw new Error("Network disabled in live-status fixture"); },
  });
  function load(filename) {
    // Native accessibility is an OS boundary; recording tests must not query the host desktop.
    if (filename.endsWith("/dictation/macos.ts")) return { createMacDictationBridge: () => undefined };
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
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
        return id => id === "node-mac-permissions" ? { getAuthStatus: () => "authorized" } : nativeRequire(id);
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
  invoke = (name, raw) => handlers.get(`app:${name}`)({}, raw);
  return {
    invoke,
    async start() {
      const starting = invoke("start");
      const win = await captureLoaded.promise;
      ipcMain.emit("capture:ready", { sender: win.webContents });
      assert.equal((await starting).ok, true);
      const id = invoke("snapshot").recording.sessionId;
      metadataPath = join(root, "Earshot", "sessions", id, "session.json");
      return { win, id };
    },
    ready() { sockets.forEach(socket => socket.ready()); },
    disconnect() { sockets[0].disconnect(); },
    deny() { sockets[0].deny(); },
    pcm(win, track, bytes) { for (let offset = 0; offset < bytes.length; offset += 8192) ipcMain.emit("capture:pcm", { sender: win.webContents }, track, bytes.subarray(offset, offset + 8192)); },
    clearNotifications() { windows.forEach(win => { win.notifications = []; }); },
    delivery(status) {
      return Object.fromEntries(["library", "glance"].map(surface => [
        surface, windows.find(win => win.surface === surface)?.notifications.includes(status) ?? false,
      ]));
    },
    failMetadata(code) {
      metadataFault = code;
      if (code === "EACCES") fs.chmodSync(metadataPath, 0o400);
    },
    restoreWrites() { metadataFault = null; fs.chmodSync(metadataPath, 0o600); },
    removeCredential() { keyAvailable = false; },
    session() { return JSON.parse(fs.readFileSync(metadataPath, "utf8")); },
    wav(name) { return fs.readFileSync(join(dirname(metadataPath), name)); },
  };
}

for (const status of ["connected", "reconnecting", "disconnected"]) {
  for (const failure of ["EIO", "EACCES", null]) {
    test(`${status} ${failure ? `metadata ${failure}` : "writable metadata control"} publishes to both windows and preserves audio/save recovery`, async t => {
      const h = await launch(t);
      const { win, id } = await h.start();
      if (status !== "connected") h.ready();
      const before = { you: Buffer.alloc(32000, 1), other: Buffer.alloc(32000, 2) };
      const after = { you: Buffer.alloc(32000, 3), other: Buffer.alloc(32000, 4) };
      for (const track of ["you", "other"]) h.pcm(win, track, before[track]);
      h.clearNotifications();
      if (failure) h.failMetadata(failure);

      let callbackError = null;
      try { status === "connected" ? h.ready() : status === "disconnected" ? h.deny() : h.disconnect(); }
      catch (error) { callbackError = error; }
      const observed = {
        callbackError: callbackError?.code ?? (callbackError ? callbackError.message : null),
        ...h.delivery(status),
      };
      t.diagnostic(JSON.stringify({ status, failure, observed }));
      if (callbackError) t.diagnostic(callbackError.stack);
      assert.equal(h.invoke("snapshot").recording.connection, status);
      assert.equal(Boolean(h.invoke("snapshot").recording.storageWarning), Boolean(failure));
      assert.equal(h.invoke("snapshot").capturePhase, "recording");
      for (const track of ["you", "other"]) h.pcm(win, track, after[track]);
      h.removeCredential();
      if (failure) {
        assert.equal((await h.invoke("stop")).ok, false, "persistent metadata failure must retain save recovery");
        assert.equal(h.invoke("snapshot").capturePhase, "finalize_failed");
        assert.equal(h.invoke("snapshot").recording.sessionId, id);
        h.restoreWrites();
      }
      assert.equal((await h.invoke("stop")).ok, true, "saving succeeds after metadata storage recovers");
      assert.equal(h.session().jobs.live, status !== "connected" ? "failed" : "done", "stop retry commits the pending live status before finalization");
      assert.equal(h.invoke("snapshot").recording, null);
      assert.equal(h.session().status, "complete");
      for (const [track, name] of [["you", "mic.wav"], ["other", "system.wav"]]) {
        const audio = h.wav(name);
        assert.equal(audio.readUInt32LE(40), 64000);
        assert.deepEqual(audio.subarray(44), Buffer.concat([before[track], after[track]]), "audio before and after status failure survives unchanged");
      }
      t.diagnostic("audio before/after preserved on both tracks; stop/save recovery passed");
      assert.deepEqual(observed, { callbackError: null, library: true, glance: true },
        "connection status must reach both windows without a WebSocket callback exception, even when metadata cannot be written");
    });
  }
}
