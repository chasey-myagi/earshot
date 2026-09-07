import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROD_BUNDLE_ID, applyProdIdentity, writePackagedPayload, packageApp } from "./package-app.mjs";
import { VOICEPRINT_MODEL } from "./fetch-voiceprint-model.mjs";

test('packaging refuses missing koffi native binaries before building or replacing the existing app', () => {
  const root = mkdtempSync(join(tmpdir(), 'earshot-missing-koffi-'));
  try {
    mkdirSync(join(root, 'node_modules/electron/dist/Electron.app'), {recursive:true});
    mkdirSync(join(root, 'dist/Earshot.app'), {recursive:true});
    writeFileSync(join(root, 'dist/Earshot.app/keep.txt'), 'previous build');
    assert.throws(() => packageApp(root), /^Error: Missing required koffi native payload:/);
    assert.equal(readFileSync(join(root, 'dist/Earshot.app/keep.txt'), 'utf8'), 'previous build');
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test("applyProdIdentity uses a stable Applications identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "earshot-prod-plist-"));
  const plist = join(dir, "Info.plist");
  try {
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Electron</string>
  <key>CFBundleIdentifier</key><string>com.github.Electron</string>
  <key>CFBundleName</key><string>Electron</string>
</dict></plist>
`,
    );
    applyProdIdentity(plist);
    const text = readFileSync(plist, "utf8");
    assert.match(text, new RegExp(`<string>${PROD_BUNDLE_ID}</string>`));
    assert.match(text, /<string>Earshot<\/string>/);
    assert.match(text, /<string>Electron<\/string>/);
    assert.match(text, /NSScreenCaptureUsageDescription/);
    assert.match(text, /NSMicrophoneUsageDescription/);
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    assert.match(text, new RegExp(`<key>CFBundleShortVersionString</key>\\s*<string>${version.replaceAll('.', '\\.')}</string>`));
    assert.match(text, new RegExp(`<key>CFBundleVersion</key>\\s*<string>${version.replaceAll('.', '\\.')}</string>`));
    assert.match(text, /<key>CFBundleIconFile<\/key>\s*<string>Earshot.icns<\/string>/);
    assert.doesNotMatch(text, /com\.github\.Electron/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writePackagedPayload puts the built app inside Resources without a capture helper", () => {
  const dir = mkdtempSync(join(tmpdir(), "earshot-prod-payload-"));
  try {
    const appPath = join(dir, "Earshot.app");
    const outDir = join(dir, "out");
    mkdirSync(join(outDir, "main"), { recursive: true });
    writeFileSync(join(outDir, "main", "index.js"), "main");
    writePackagedPayload(appPath, { outDir });
    assert.equal(readFileSync(join(appPath, "Contents/Resources/app/out/main/index.js"), "utf8"), "main");
    assert.equal(JSON.parse(readFileSync(join(appPath, "Contents/Resources/app/package.json"), "utf8")).main, "./out/main/index.js");
    assert.equal(existsSync(join(appPath, "Contents/Resources/Earshot Capture.app")), false);
    assert.deepEqual(readFileSync(join(appPath, "Contents/Resources/Earshot.icns")), readFileSync(new URL('../assets/Earshot.icns', import.meta.url)));
    assert.deepEqual(readFileSync(join(appPath, "Contents/Resources/earshot-icon.png")), readFileSync(new URL('../assets/earshot-icon.png', import.meta.url)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writePackagedPayload copies native dependency closure and licenses without an optional model", () => {
  const dir = mkdtempSync(join(tmpdir(), "earshot-vp-payload-"));
  try {
    const appPath = join(dir, "Earshot.app");
    const outDir = join(dir, "out");
    mkdirSync(join(outDir, "main"), { recursive: true });
    writeFileSync(join(outDir, "main", "index.js"), "main");
    writeFileSync(join(outDir, "main", "voiceprint-worker.js"), "worker");
    mkdirSync(join(dir, "node_modules/sherpa-onnx-node"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules/sherpa-onnx-node/package.json"),
      `${JSON.stringify({ name: "sherpa-onnx-node", optionalDependencies: { "sherpa-onnx-darwin-arm64": "1.13.6" } })}\n`,
    );
    mkdirSync(join(dir, "node_modules/sherpa-onnx-darwin-arm64"), { recursive: true });
    writeFileSync(join(dir, "node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node"), "native");
    mkdirSync(join(dir, "node_modules/node-mac-permissions"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules/node-mac-permissions/package.json"),
      `${JSON.stringify({ name: "node-mac-permissions", dependencies: { bindings: "^1.5.0" } })}\n`,
    );
    mkdirSync(join(dir, "node_modules/bindings"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules/bindings/package.json"),
      `${JSON.stringify({ name: "bindings", dependencies: { "file-uri-to-path": "1.0.0" } })}\n`,
    );
    mkdirSync(join(dir, "node_modules/file-uri-to-path"), { recursive: true });
    writeFileSync(join(dir, "node_modules/file-uri-to-path/package.json"), `${JSON.stringify({ name: "file-uri-to-path" })}\n`);
    mkdirSync(join(dir, "models"), { recursive: true });
    mkdirSync(join(dir, "node_modules/koffi"), { recursive: true });
    writeFileSync(join(dir, "node_modules/koffi/package.json"), JSON.stringify({ name: "koffi", optionalDependencies: { "@koromix/koffi-darwin-arm64": "3.2.1", "@koromix/koffi-linux-x64": "3.2.1" } }));
    mkdirSync(join(dir, "node_modules/@koromix/koffi-darwin-arm64"), { recursive: true });
    writeFileSync(join(dir, "node_modules/@koromix/koffi-darwin-arm64/koffi.node"), "ffi");
    mkdirSync(join(dir, "licenses"), { recursive: true });
    writeFileSync(join(dir, "LICENSE"), "project-license");
    writeFileSync(join(dir, "THIRD_PARTY_NOTICES.md"), "notices");
    writeFileSync(join(dir, "licenses/fixture.txt"), "dependency-license");
    mkdirSync(join(dir, "node_modules/electron/dist"), { recursive: true });
    writeFileSync(join(dir, "node_modules/electron/LICENSE"), "electron-license");
    writeFileSync(join(dir, "node_modules/electron/dist/LICENSES.chromium.html"), "chromium-licenses");
    writePackagedPayload(appPath, { outDir, root: dir });
    const resources = join(appPath, "Contents/Resources");
    assert.equal(readFileSync(join(resources, "app/out/main/voiceprint-worker.js"), "utf8"), "worker");
    assert.equal(existsSync(join(resources, "app/node_modules/sherpa-onnx-node/package.json")), true);
    assert.equal(readFileSync(join(resources, "app/node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node"), "utf8"), "native");
    assert.equal(readFileSync(join(resources, "LICENSE"), "utf8"), "project-license");
    assert.equal(readFileSync(join(resources, "licenses/fixture.txt"), "utf8"), "dependency-license");
    assert.equal(readFileSync(join(resources, "LICENSES.chromium.html"), "utf8"), "chromium-licenses");
    // 运行时依赖闭包必须进包：漏掉 bindings 会让权限模块在打包后静默失效
    assert.equal(existsSync(join(resources, "app/node_modules/bindings/package.json")), true);
    assert.equal(existsSync(join(resources, "app/node_modules/file-uri-to-path/package.json")), true);
    assert.equal(readFileSync(join(resources, "app/node_modules/@koromix/koffi-darwin-arm64/koffi.node"), "utf8"), "ffi");
    assert.equal(existsSync(join(resources, "models", VOICEPRINT_MODEL)), false);
    assert.equal(existsSync(join(resources, "app.asar")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('packaging refuses missing permissions and speaker native payloads before replacing a build', () => {
  const root = mkdtempSync(join(tmpdir(), 'earshot-native-preflight-'));
  try {
    const files = ['koffi/package.json', `@koromix/koffi-darwin-${process.arch}/darwin_${process.arch}/koffi.node`, 'node-mac-permissions/build/Release/permissions.node', 'sherpa-onnx-node/package.json', ...['sherpa-onnx.node','libsherpa-onnx-c-api.dylib','libsherpa-onnx-cxx-api.dylib','libonnxruntime.dylib'].map(name => `sherpa-onnx-darwin-${process.arch}/${name}`)];
    mkdirSync(join(root,'node_modules/electron/dist/Electron.app'), {recursive:true});
    mkdirSync(join(root,'dist/Earshot.app'), {recursive:true});
    writeFileSync(join(root,'dist/Earshot.app/keep.txt'),'previous build');
    for (const file of files) {
      if (!file.startsWith('koffi/') && !file.startsWith('@koromix/')) {
        assert.throws(() => packageApp(root), /Missing required .*native payload/);
        assert.equal(readFileSync(join(root,'dist/Earshot.app/keep.txt'),'utf8'),'previous build');
      }
      mkdirSync(join(root,'node_modules',file,'..'),{recursive:true});
      writeFileSync(join(root,'node_modules',file),'fixture');
    }
    mkdirSync(join(root,'models'),{recursive:true});writeFileSync(join(root,'models',VOICEPRINT_MODEL),'corrupt model');
    assert.throws(() => packageApp(root), /voiceprint model checksum mismatch/);
    assert.equal(readFileSync(join(root,'dist/Earshot.app/keep.txt'),'utf8'),'previous build');
  } finally {rmSync(root,{recursive:true,force:true});}
});
