import { trayFixture } from "../../scripts/electron-tray-fixture.mjs";
// Failed capture leaves the recording-only glance hidden and the library usable.
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
  const root = fs.mkdtempSync(join(tmpdir(), "earshot-c1-"));
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
    quit() {},
  });
  const electron = { ...trayFixture(),
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
    console, process, Buffer, Uint8Array, Error, URL, AbortController, setInterval, clearInterval, setTimeout, clearTimeout,
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
    try {
      if (invoke("snapshot").capturePhase === "recording") {
        app.emit("before-quit", { preventDefault() {} });
        await invoke("stop");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    library, invoke,
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

test("C1: failed capture after closing the starting library restores the library and hides glance", { timeout: 5000 }, async t => {
  const h = await launch(t);
  const { starting, captureWindow } = await h.startPending();
  h.library.close();
  assert.deepEqual(h.visibility(), { libraryVisible: false, glanceVisible: true });
  h.rejectCapture(captureWindow);
  const result = await starting;
  assert.equal(result.ok, false);
  assert.equal(result.code, "no_mic");
  assert.equal(result.error, "麦克风采集被拒绝");
  assert.equal(h.invoke("snapshot").capturePhase, "idle");
  assert.equal(h.invoke("snapshot").recording, null);
  assert.deepEqual(h.visibility(), { libraryVisible: true, glanceVisible: false },
    "failed startup must expose the retry surface and remove recording-only glance");
  const retry = await h.startPending();
  h.acceptCapture(retry.captureWindow);
  assert.equal((await retry.starting).ok, true, "restored library can start a new recording");
});

test("control: successful capture after closing the starting library shows glance until stop restores library", { timeout: 5000 }, async t => {
  const h = await launch(t);
  const { starting, captureWindow } = await h.startPending();
  h.library.close();
  assert.deepEqual(h.visibility(), { libraryVisible: false, glanceVisible: true });
  h.acceptCapture(captureWindow);
  assert.equal((await starting).ok, true);
  assert.equal(h.invoke("snapshot").capturePhase, "recording");
  assert.deepEqual(h.visibility(), { libraryVisible: false, glanceVisible: true });
  assert.equal((await h.invoke("stop")).ok, true);
  assert.equal(h.invoke("snapshot").capturePhase, "idle");
  assert.equal(h.invoke("snapshot").recording, null);
  assert.deepEqual(h.visibility(), { libraryVisible: true, glanceVisible: false });
});
