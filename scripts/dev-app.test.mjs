import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEV_BUNDLE_ID,
  applyDevIdentity,
  createBootstrapSource,
  createDevEnv,
  createMacosDevelopmentLaunch,
  installBootstrap,
  toProcessMatchPattern,
  writeDevEnv,
} from "./dev-app.mjs";

test("launches the signed development bundle through LaunchServices", () => {
  assert.deepEqual(createMacosDevelopmentLaunch("/repo/Earshot.app", "/repo/app.log"), {
    command: "open",
    args: ["-n", "-a", "/repo/Earshot.app", "--stdout", "/repo/app.log", "--stderr", "/repo/app.log"],
  });
});

test("dev env only carries the renderer URL the Quit & Reopen launch will need", () => {
  const env = createDevEnv({
    ELECTRON_RENDERER_URL: "http://localhost:5173",
    NODE_ENV_ELECTRON_VITE: "development",
    PATH: "/should/not/travel",
    DASHSCOPE_API_KEY: "sk-do-not-write",
  });
  assert.deepEqual(env, {
    schemaVersion: 1,
    env: {
      ELECTRON_RENDERER_URL: "http://localhost:5173",
      NODE_ENV_ELECTRON_VITE: "development",
    },
  });
});

test("writeDevEnv publishes a 0600 json file the bootstrap can reread", () => {
  const dir = mkdtempSync(join(tmpdir(), "earshot-env-"));
  const file = join(dir, "dev-env.json");
  try {
    writeDevEnv(file, createDevEnv({ ELECTRON_RENDERER_URL: "http://localhost:5173" }));
    const published = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(published.env.ELECTRON_RENDERER_URL, "http://localhost:5173");
    assert.equal(statSync(file).mode & 0o077, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyDevIdentity names the app Earshot and keeps the Electron executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "earshot-plist-"));
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
    applyDevIdentity(plist);
    assert.match(readFileSync(plist, "utf8"), /<key>CFBundleIconFile<\/key>\s*<string>Earshot.icns<\/string>/);
    const text = readFileSync(plist, "utf8");
    assert.match(text, new RegExp(`<string>${DEV_BUNDLE_ID}</string>`));
    assert.match(text, /<string>Earshot<\/string>/);
    assert.match(text, /<string>Electron<\/string>/);
    assert.match(text, /NSScreenCaptureUsageDescription/);
    assert.match(text, /NSMicrophoneUsageDescription/);
    assert.doesNotMatch(text, /com\.github\.Electron/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bootstrap loads out/main from the repo and adopts the published renderer URL", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "earshot-boot-")));
  const repo = join(root, "repo");
  const envFile = join(root, "dev-env.json");
  const loadedFile = join(root, "loaded.json");
  const calls = [];
  mkdirSync(join(repo, "out/main"), { recursive: true });
  mkdirSync(join(root, "node_modules/electron"), { recursive: true });
  writeFileSync(join(root, "node_modules/electron/package.json"), JSON.stringify({ name: "electron", main: "index.js" }));
  writeFileSync(
    join(root, "node_modules/electron/index.js"),
    `module.exports = { app: {
      setAppPath: (p) => globalThis.__earshotCalls.push(["setAppPath", p]),
      exit: (c) => globalThis.__earshotCalls.push(["exit", c]),
    } };`,
  );
  writeFileSync(
    join(repo, "out/main/index.js"),
    `import { writeFileSync } from "node:fs";
     writeFileSync(${JSON.stringify(loadedFile)}, JSON.stringify({
       cwd: process.cwd(),
       url: process.env.ELECTRON_RENDERER_URL ?? null,
     }));`,
  );
  writeDevEnv(envFile, createDevEnv({ ELECTRON_RENDERER_URL: "http://localhost:5173" }));
  const bootstrapFile = join(root, "bootstrap.cjs");
  writeFileSync(bootstrapFile, createBootstrapSource(repo, envFile));
  const previousCwd = process.cwd();
  const previousUrl = process.env.ELECTRON_RENDERER_URL;
  globalThis.__earshotCalls = calls;
  try {
    delete process.env.ELECTRON_RENDERER_URL;
    createRequire(join(root, "x.cjs"))(bootstrapFile);
    for (let i = 0; i < 200 && !existsSync(loadedFile); i += 1) {
      await new Promise((done) => setImmediate(done));
    }
    const loaded = JSON.parse(readFileSync(loadedFile, "utf8"));
    assert.deepEqual(calls, [["setAppPath", repo]]);
    assert.equal(loaded.cwd, repo);
    assert.equal(loaded.url, "http://localhost:5173");
  } finally {
    process.chdir(previousCwd);
    if (previousUrl === undefined) delete process.env.ELECTRON_RENDERER_URL;
    else process.env.ELECTRON_RENDERER_URL = previousUrl;
    delete globalThis.__earshotCalls;
    rmSync(root, { recursive: true, force: true });
  }
});

test("installBootstrap occupies default_app.asar so a unique bundle id still loads the project", () => {
  const dir = mkdtempSync(join(tmpdir(), "earshot-boot-app-"));
  const appPath = join(dir, "Earshot.app");
  try {
    installBootstrap(appPath, "/repo", "/repo/.earshot-dev/dev-env.json");
    const payload = join(appPath, "Contents/Resources/default_app.asar");
    assert.equal(JSON.parse(readFileSync(join(payload, "package.json"), "utf8")).main, "main.cjs");
    assert.match(readFileSync(join(payload, "main.cjs"), "utf8"), /out\/main\/index\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("process match treats the bundle path as a literal", () => {
  assert.equal(
    toProcessMatchPattern("/Users/me/Dev/earshot/.earshot-dev/Earshot.app/Contents/MacOS/Electron"),
    "/Users/me/Dev/earshot/\\.earshot-dev/Earshot\\.app/Contents/MacOS/Electron",
  );
});
