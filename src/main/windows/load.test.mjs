import ts from "typescript";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { resolvePreloadPath } from "./load.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("resolvePreloadPath prefers the CJS file when both exist", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-preload-"));
  writeFileSync(join(root, "index.js"), "cjs");
  writeFileSync(join(root, "index.mjs"), "esm");
  assert.equal(resolvePreloadPath(root), join(root, "index.js"));
});

test("resolvePreloadPath falls back to index.mjs when that is the only build", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-preload-"));
  writeFileSync(join(root, "index.mjs"), "esm");
  assert.equal(resolvePreloadPath(root), join(root, "index.mjs"));
});

function windowLoader(env) {
  const calls = [], events = new Map();
  const win = { webContents: { on: (name, fn) => events.set(name, fn), setWindowOpenHandler: fn => events.set('popup', fn) },
    loadURL: async (...args) => { calls.push(['url', ...args]); }, loadFile: async (...args) => { calls.push(['file', ...args]); } };
  const source = ts.transpileModule(readFileSync(new URL('./load.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  runInNewContext(source, { exports, require: createRequire(import.meta.url), process: { env }, console, URL, __dirname: '/app/out/main' });
  return { api: exports, win, calls, events };
}
test('production ignores a poisoned renderer URL and loads its bundled page', async () => {
  const h = windowLoader({ NODE_ENV_ELECTRON_VITE: 'production', ELECTRON_RENDERER_URL: 'https://attacker.example' });
  await h.api.loadRenderer(h.win);
  assert.equal(h.calls[0][0], 'file');
  assert.equal(h.calls[0][1], '/app/out/renderer/index.html');
});

test('development serves only loopback pages and blocks external navigation and popups', async () => {
  for (const url of ['https://attacker.example', 'http://localhost.attacker.example', 'http://user@localhost:5173']) {
    const h=windowLoader({NODE_ENV_ELECTRON_VITE:'development',ELECTRON_RENDERER_URL:url});
    await h.api.loadRenderer(h.win);assert.equal(h.calls[0][0],'file');
  }
  const h=windowLoader({NODE_ENV_ELECTRON_VITE:'development',ELECTRON_RENDERER_URL:'http://127.0.0.1:5173'});
  await h.api.loadRenderer(h.win,'settings');assert.equal(h.calls[0][1],'http://127.0.0.1:5173/index.html#settings');
  let denied=false;h.events.get('will-navigate')({preventDefault(){denied=true;}},'https://attacker.example');assert.equal(denied,true);
  denied=false;h.events.get('will-redirect')({preventDefault(){denied=true;}},'https://attacker.example');assert.equal(denied,true);
  denied=false;h.events.get('will-navigate')({preventDefault(){denied=true;}},'http://127.0.0.1:5173/index.html#glance');assert.equal(denied,false);
  assert.equal(h.events.get('popup')().action,'deny');
});
test('media permission belongs only to the live capture window and its main document', () => {
  const h=windowLoader({NODE_ENV_ELECTRON_VITE:'production'});let request,check,closed=false;
  let url='file:///app/out/renderer/capture.html';
  h.win.isDestroyed=()=>closed;h.win.webContents.getURL=()=>url;
  h.win.webContents.session={setPermissionRequestHandler:fn=>request=fn,setPermissionCheckHandler:fn=>check=fn};
  h.api.configureCapturePermissions(h.win,'capture.html');
  const permitted=(contents,permission,details={isMainFrame:true})=>{let result;request(contents,permission,v=>result=v,details);return result;};
  assert.equal(permitted(h.win.webContents,'media'),true);
  assert.equal(permitted({},'media'),false);
  assert.equal(permitted(h.win.webContents,'geolocation'),false);
  assert.equal(permitted(h.win.webContents,'media',{isMainFrame:false}),false);
  assert.equal(permitted(h.win.webContents,'media',{isMainFrame:true,requestingUrl:'https://attacker.example'}),false);
  assert.equal(check(h.win.webContents,'media','file://',{isMainFrame:true}),true);
  url='file:///app/out/renderer/index.html';assert.equal(permitted(h.win.webContents,'media'),false);
  url='file:///app/out/renderer/capture.html';closed=true;assert.equal(permitted(h.win.webContents,'media'),false);
});

test('a remote file host cannot pass navigation or capture permission checks', async () => {
  const h=windowLoader({NODE_ENV_ELECTRON_VITE:'production'});
  await h.api.loadRenderer(h.win);
  const remote='file://attacker.example/app/out/renderer/index.html';
  assert.equal(h.api.sameRendererDocument(remote,'file:///app/out/renderer/index.html'),false);
  let denied=false;h.events.get('will-navigate')({preventDefault(){denied=true;}},remote);assert.equal(denied,true);
  denied=false;h.events.get('will-redirect')({preventDefault(){denied=true;}},remote);assert.equal(denied,true);
  let request,check;h.win.isDestroyed=()=>false;
  h.win.webContents.getURL=()=> 'file://attacker.example/app/out/renderer/capture.html';
  h.win.webContents.session={setPermissionRequestHandler:fn=>request=fn,setPermissionCheckHandler:fn=>check=fn};
  h.api.configureCapturePermissions(h.win,'capture.html');
  let allowed;request(h.win.webContents,'media',value=>allowed=value,{isMainFrame:true});assert.equal(allowed,false);
  assert.equal(check(h.win.webContents,'media','null',{isMainFrame:true}),false);
});
