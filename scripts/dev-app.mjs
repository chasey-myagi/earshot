import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_ICON_FILE, installAppIcon } from "./app-icon.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEV_BUNDLE_ID = "com.earshot.dev";
const STAMP = "tcc-v1-b2-icon-v2\n";

export function developmentAppPath(root = ROOT) {
  return join(root, ".earshot-dev/Earshot.app");
}

export function developmentExecutablePath(root = ROOT) {
  return join(developmentAppPath(root), "Contents/MacOS/Electron");
}

export function developmentLogFile(root = ROOT) {
  return join(root, ".earshot-dev/app.log");
}

export function developmentEnvFile(root = ROOT) {
  return join(root, ".earshot-dev/dev-env.json");
}

export function createMacosDevelopmentLaunch(appPath, logFile) {
  return {
    command: "open",
    args: ["-n", "-a", appPath, "--stdout", logFile, "--stderr", logFile],
  };
}

export function createDevEnv(env = {}) {
  const selected = {};
  if (typeof env.ELECTRON_RENDERER_URL === "string" && env.ELECTRON_RENDERER_URL) {
    selected.ELECTRON_RENDERER_URL = env.ELECTRON_RENDERER_URL;
  }
  if (typeof env.NODE_ENV_ELECTRON_VITE === "string" && env.NODE_ENV_ELECTRON_VITE) {
    selected.NODE_ENV_ELECTRON_VITE = env.NODE_ENV_ELECTRON_VITE;
  }
  return { schemaVersion: 1, env: selected };
}

export function writeDevEnv(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function createBootstrapSource(repoRoot, envFile) {
  return [
    "const { app } = require('electron');",
    "const { join } = require('node:path');",
    "const { pathToFileURL } = require('node:url');",
    "const { readFileSync } = require('node:fs');",
    `const repoRoot = ${JSON.stringify(repoRoot)};`,
    "let published = null;",
    "try {",
    `  const candidate = JSON.parse(readFileSync(${JSON.stringify(envFile)}, 'utf8'));`,
    "  if (candidate.schemaVersion === 1) published = candidate;",
    "} catch {}",
    "if (published?.env) Object.assign(process.env, published.env);",
    "app.setAppPath(repoRoot);",
    "process.chdir(repoRoot);",
    "import(pathToFileURL(join(repoRoot, 'out/main/index.js')).href).catch((error) => {",
    "  console.error('[earshot] bootstrap failed', error);",
    "  app.exit(1);",
    "});",
    "",
  ].join("\n");
}

export function installBootstrap(appPath, repoRoot, envFile) {
  installAppIcon(appPath);
  const payload = join(appPath, "Contents/Resources/default_app.asar");
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });
  writeFileSync(
    join(payload, "package.json"),
    `${JSON.stringify({ name: "earshot-dev", main: "main.cjs", private: true }, null, 2)}\n`,
  );
  writeFileSync(join(payload, "main.cjs"), createBootstrapSource(repoRoot, envFile));
}

export function applyDevIdentity(plist) {
  setPlistString(plist, "CFBundleIdentifier", DEV_BUNDLE_ID);
  setPlistString(plist, "CFBundleName", "Earshot");
  setPlistString(plist, "CFBundleDisplayName", "Earshot");
  setPlistString(plist, "CFBundleIconFile", APP_ICON_FILE);
  setPlistString(plist, "NSScreenCaptureUsageDescription", "Earshot 需要屏幕录制来录下这场会。");
  setPlistString(plist, "NSAudioCaptureUsageDescription", "Earshot 需要系统音频来录下这场会。");
  setPlistString(plist, "NSMicrophoneUsageDescription", "Earshot 需要麦克风来录下这场会。");
  spawnSync("plutil", ["-remove", "ElectronAsarIntegrity", plist]);
}

export function toProcessMatchPattern(executable) {
  return executable.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
}

export function isDevAppRunning(root = ROOT) {
  const status = spawnSync("pgrep", ["-f", toProcessMatchPattern(developmentExecutablePath(root))]).status;
  if (status !== 0 && status !== 1) {
    throw new Error(`pgrep failed for Earshot.app (exit ${status})`);
  }
  return status === 0;
}

export function quitDevApp(root = ROOT) {
  const executable = developmentExecutablePath(root);
  const term = spawnSync("pkill", ["-TERM", "-f", toProcessMatchPattern(executable)]).status;
  if (term !== 0 && term !== 1) throw new Error(`pkill failed for Earshot.app (exit ${term})`);
  if (term === 0) spawnSync("pkill", ["-KILL", "-f", toProcessMatchPattern(executable)]);
  return term === 0;
}

export function openDevApp(root = ROOT) {
  const appPath = developmentAppPath(root);
  const logFile = developmentLogFile(root);
  writeFileSync(logFile, "", { mode: 0o600 });
  const launch = createMacosDevelopmentLaunch(appPath, logFile);
  const result = spawnSync(launch.command, launch.args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`open Earshot.app failed: ${result.stderr || result.stdout}`);
  }
}

export function ensureDevApp(root = ROOT) {
  const src = join(root, "node_modules/electron/dist/Electron.app");
  const dest = developmentAppPath(root);
  const destBin = developmentExecutablePath(root);
  const stampFile = join(root, ".earshot-dev/stamp");
  if (!existsSync(src)) throw new Error("electron 未安装");
  const stamped = existsSync(stampFile) && readFileSync(stampFile, "utf8") === STAMP;
  if (existsSync(destBin) && stamped) return destBin;

  quitDevApp(root);
  mkdirSync(join(root, ".earshot-dev"), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  run("ditto", [src, dest]);
  applyDevIdentity(join(dest, "Contents/Info.plist"));
  installBootstrap(dest, root, developmentEnvFile(root));
  run("xattr", ["-cr", dest]);
  run("codesign", ["--force", "--deep", "--sign", "-", dest]);
  run("codesign", ["--verify", "--deep", "--strict", dest]);
  writeFileSync(stampFile, STAMP);
  return destBin;
}

function setPlistString(plist, key, value) {
  if (spawnSync("plutil", ["-replace", key, "-string", value, plist]).status === 0) return;
  run("plutil", ["-insert", key, "-string", value, plist]);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}
