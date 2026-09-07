import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VOICEPRINT_MODEL, VOICEPRINT_MODEL_SHA256 } from "./fetch-voiceprint-model.mjs";
import { APP_ICON_FILE, installAppIcon } from "./app-icon.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
export const PROD_BUNDLE_ID = "app.earshot";
export const APPLICATIONS_APP = "/Applications/Earshot.app";

export function packagedAppPath(root = ROOT) {
  return join(root, "dist/Earshot.app");
}

/**
 * 优先用本机的 Apple Development 证书：签名跨构建稳定，TCC 授权不会每次打包都归零。
 * 找不到就退回 ad-hoc（"-"）。
 */
export function signingIdentity() {
  const result = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  const match = (result.stdout ?? "").match(/"(Apple Development: [^"]+)"/);
  return match ? match[1] : "-";
}

export function applyProdIdentity(plist, version = APP_VERSION) {
  setPlistString(plist, "CFBundleShortVersionString", version);
  setPlistString(plist, "CFBundleVersion", version);
  setPlistString(plist, "CFBundleIdentifier", PROD_BUNDLE_ID);
  setPlistString(plist, "CFBundleName", "Earshot");
  setPlistString(plist, "CFBundleDisplayName", "Earshot");
  setPlistString(plist, "CFBundleIconFile", APP_ICON_FILE);
  setPlistString(plist, "NSScreenCaptureUsageDescription", "Earshot 需要屏幕录制来录下这场会。");
  setPlistString(plist, "NSAudioCaptureUsageDescription", "Earshot 需要系统音频来录下这场会。");
  setPlistString(plist, "NSMicrophoneUsageDescription", "Earshot 需要麦克风来录下这场会。");
  spawnSync("plutil", ["-remove", "ElectronAsarIntegrity", plist]);
}

export function writePackagedPayload(appPath, input) {
  installAppIcon(appPath);
  const resources = join(appPath, "Contents/Resources");
  const payload = join(resources, "app");
  rmSync(join(resources, "default_app.asar"), { recursive: true, force: true });
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });
  writeFileSync(
    join(payload, "package.json"),
    `${JSON.stringify({ name: "earshot", version: APP_VERSION, license: "MIT", type: "module", main: "./out/main/index.js" }, null, 2)}\n`,
  );
  run("ditto", [input.outDir, join(payload, "out")]);
  copyLicensePayload(appPath, input.root ?? ROOT);
  if (input.root) copyVoiceprintPayload(appPath, input.root);
}

function copyLicensePayload(appPath, root) {
  const resources = join(appPath, "Contents/Resources");
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "licenses"]) {
    run("ditto", [join(root, file), join(resources, file)]);
  }
  run("ditto", [join(root, "node_modules/electron/LICENSE"), join(resources, "LICENSE.electron")]);
  run("ditto", [join(root, "node_modules/electron/dist/LICENSES.chromium.html"), join(resources, "LICENSES.chromium.html")]);
}

export function packageApp(root = ROOT) {
  const src = join(root, "node_modules/electron/dist/Electron.app");
  if (!existsSync(src)) throw new Error("electron 未安装");
  for (const file of ['koffi/package.json', `@koromix/koffi-darwin-${process.arch}/darwin_${process.arch}/koffi.node`]) {
    if (!existsSync(join(root, 'node_modules', file))) throw new Error(`Missing required koffi native payload: ${file}`);
  }
  for (const file of ['node-mac-permissions/build/Release/permissions.node', 'sherpa-onnx-node/package.json',
    ...['sherpa-onnx.node', 'libsherpa-onnx-c-api.dylib', 'libsherpa-onnx-cxx-api.dylib', 'libonnxruntime.dylib'].map(name => `sherpa-onnx-darwin-${process.arch}/${name}`)]) {
    if (!existsSync(join(root, 'node_modules', file))) throw new Error(`Missing required native payload: ${file}`);
  }
  const model = join(root, "models", VOICEPRINT_MODEL);
  if (existsSync(model)) verifyVoiceprintModel(model);
  run("npx", ["--no-install", "electron-vite", "build"], root);
  const dest = packagedAppPath(root);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  run("ditto", [src, dest]);
  applyProdIdentity(join(dest, "Contents/Info.plist"));
  writePackagedPayload(dest, { outDir: join(root, "out"), root });
  run("xattr", ["-cr", dest]);
  run("codesign", ["--force", "--deep", "--sign", signingIdentity(), dest]);
  return dest;
}

export function installApp(root = ROOT) {
  const dest = packageApp(root);
  spawnSync("pkill", ["-f", "Earshot.app/Contents/MacOS/Electron"], { stdio: "ignore" });
  rmSync(APPLICATIONS_APP, { recursive: true, force: true });
  run("ditto", [dest, APPLICATIONS_APP]);
  run("xattr", ["-cr", APPLICATIONS_APP]);
  run("codesign", ["--force", "--deep", "--sign", signingIdentity(), APPLICATIONS_APP]);
  return APPLICATIONS_APP;
}

export function listVoiceprintNodeModules(root = ROOT) {
  const pkgPath = join(root, "node_modules/sherpa-onnx-node/package.json");
  if (!existsSync(pkgPath)) return [];
  const names = ["sherpa-onnx-node"];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
      if (existsSync(join(root, "node_modules", name))) names.push(name);
    }
  } catch {
    // missing optional platform package is fine; voiceprint will disable
  }
  return names;
}

/** 按 dependencies 递归收集要打进包的原生模块闭包（漏掉 bindings 这类运行时依赖会静默失效） */
export function listBundledNodeModules(root = ROOT) {
  const queue = [...listVoiceprintNodeModules(root), "node-mac-permissions", "koffi"];
  const seen = new Set();
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const modDir = join(root, "node_modules", name);
    if (!existsSync(modDir)) continue;
    seen.add(name);
    const pkgPath = join(modDir, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      queue.push(...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}));
    } catch {
      // 没有可读的依赖清单就只拷模块本身
    }
  }
  return [...seen];
}

export function copyVoiceprintPayload(appPath, root = ROOT) {
  const resources = join(appPath, "Contents/Resources");
  const modulesDest = join(resources, "app/node_modules");
  for (const name of listBundledNodeModules(root)) {
    const src = join(root, "node_modules", name);
    if (!existsSync(src)) continue;
    mkdirSync(modulesDest, { recursive: true });
    run("ditto", [src, join(modulesDest, name)]);
  }
  const modelSrc = join(root, "models", VOICEPRINT_MODEL);
  if (!existsSync(modelSrc)) return;
  verifyVoiceprintModel(modelSrc);
  const modelDestDir = join(resources, "models");
  mkdirSync(modelDestDir, { recursive: true });
  run("ditto", [modelSrc, join(modelDestDir, VOICEPRINT_MODEL)]);
  verifyVoiceprintModel(join(modelDestDir, VOICEPRINT_MODEL));
}

function verifyVoiceprintModel(path) {
  if (createHash("sha256").update(readFileSync(path)).digest("hex") !== VOICEPRINT_MODEL_SHA256) {
    throw new Error("voiceprint model checksum mismatch");
  }
}

function setPlistString(plist, key, value) {
  if (spawnSync("plutil", ["-replace", key, "-string", value, plist]).status === 0) return;
  run("plutil", ["-insert", key, "-string", value, plist]);
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { encoding: "utf8", cwd });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dest = process.argv.includes("--install") ? installApp() : packageApp();
  process.stdout.write(`${dest}\n`);
}
