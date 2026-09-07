// A failed stop remains retryable. Restoring writes and retrying must preserve valid metadata and a session that survives reopening.
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
async function launch(t, existingRoot) {
  const root = existingRoot ?? fs.mkdtempSync(join(tmpdir(), "earshot-c3-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const windows = [];
  const sockets = [];
  let keyAvailable = !existingRoot;
  let fault = null;
  const timers = new Set();
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  class Socket {
    listeners = new Map();
    constructor() { sockets.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    send() {}
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
    if (fault && typeof path === "string" && dirname(path) === fault.dir) {
      let doc;
      try { doc = JSON.parse(String(data)); } catch {}
      if (doc?.id === fault.id && doc.status === "complete") {
        if (fault.mode === "after-truncate") {
          const fd = fs.openSync(path, "w");
          try { fs.writeSync(fd, String(data).slice(0, 12)); }
          finally { fs.closeSync(fd); }
        }
        throw Object.assign(new Error("fixture metadata write EIO"), { code: "EIO" });
      }
    }
    return fs.writeFileSync(path, data, options);
  } };
  const nativePermissions = { getAuthStatus: () => "authorized" };
  const modules = new Map();
  const context = createContext({
    console, process, Buffer, Uint8Array, Error, URL, AbortController, ArrayBuffer,
    setTimeout(fn, ms, ...args) {
      const timer = setTimeout(() => { timers.delete(timer); fn(...args); }, ms);
      timers.add(timer);
      return timer;
    }, clearTimeout, setInterval, clearInterval,
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
    root, invoke,
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

function readMetadata(path) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); }
  catch { return null; }
}

async function retryAfterWriteFailure(t, mode) {
  const h = await launch(t);
  const capture = await h.start();
  const id = h.invoke("snapshot").recording.sessionId;
  const dir = join(h.root, "Earshot", "sessions", id);
  const path = join(dir, "session.json");
  const tracks = [["you", "mic.wav", Buffer.alloc(32000, 1)], ["other", "system.wav", Buffer.alloc(32000, 2)]];
  for (const [track, , pcm] of tracks) h.pcm(capture, track, pcm);
  h.transcript();
  const liveFile = join(dir, "live.jsonl");
  const transcriptBefore = fs.readFileSync(liveFile, "utf8");
  assert.deepEqual(transcriptBefore.trim().split("\n").map(row => JSON.parse(row).text),
    ["confirmed before save failure"]);
  h.removeCredential();
  h.failMetadata(id, mode);
  const first = await h.invoke("stop");
  assert.equal(first.ok, false, "the initial persistence error is exposed");
  assert.equal(h.invoke("snapshot").capturePhase, "finalize_failed");
  assert.equal(h.invoke("snapshot").recording.sessionId, id);
  assert.deepEqual(Array.from(h.invoke("snapshot").recording.turns, turn => turn.text),
    ["confirmed before save failure"]);
  const firstMetadata = fs.readFileSync(path, "utf8");
  h.restoreWrites();
  const retry = await h.invoke("stop");
  const snapshot = h.invoke("snapshot");
  const metadata = readMetadata(path);
  for (const [, name, pcm] of tracks) {
    const file = fs.readFileSync(join(dir, name));
    assert.equal(file.toString("ascii", 0, 4), "RIFF");
    assert.equal(file.readUInt32LE(40), pcm.length);
    assert.deepEqual(file.subarray(44), pcm, `${name} retains exact PCM after retry`);
  }
  assert.equal(fs.readFileSync(liveFile, "utf8"), transcriptBefore);
  // Start a fresh production main/store only once the first app claims success.
  // A legitimate retained recovery state is not forcibly crashed by this test.
  let reopened = null;
  if (retry.ok) reopened = (await launch(t, h.root)).invoke("snapshot");
  const evidence = {
    firstOk: first.ok,
    firstMetadata,
    retryOk: retry.ok,
    phase: snapshot.capturePhase,
    recording: snapshot.recording?.sessionId ?? null,
    validMetadata: metadata?.id === id && metadata?.status === "complete",
    reopenedIds: reopened ? Array.from(reopened.sessions, row => row.id) : null,
    reopenedSelected: reopened?.selected?.id ?? null,
    quitPrevented: h.quitPrevented(),
  };
  t.diagnostic(JSON.stringify(evidence));
  if (!retry.ok) {
    assert.equal(snapshot.capturePhase, "finalize_failed");
    assert.equal(snapshot.recording?.sessionId, id);
    assert.deepEqual(Array.from(snapshot.recording.turns, turn => turn.text), ["confirmed before save failure"]);
    assert.equal(evidence.quitPrevented, true, "unsaved recording must block quitting");
    return { retry, evidence };
  }
  assert.deepEqual({
    committed: evidence.validMetadata,
    listedAfterReopen: evidence.reopenedIds.includes(id),
    detailAfterReopen: evidence.reopenedSelected === id,
  }, {
    committed: true, listedAfterReopen: true, detailAfterReopen: true,
  }, "successful save must commit valid metadata and retain normal library access after reopening");
  assert.equal(snapshot.capturePhase, "idle");
  assert.equal(snapshot.recording, null);
  assert.deepEqual(Array.from(reopened.selected.turns, turn => turn.text), ["confirmed before save failure"]);
  return { retry, evidence };
}

test("C3: retry after a truncated metadata write either commits the session or retains recovery", { timeout: 5000 }, async t => {
  await retryAfterWriteFailure(t, "after-truncate");
});

test("control: retry after a metadata write rejected before open restores the saved session", { timeout: 5000 }, async t => {
  const { retry } = await retryAfterWriteFailure(t, "before-open");
  assert.equal(retry.ok, true);
});
