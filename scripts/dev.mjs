import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDevApp } from "./dev-app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const stub = join(here, "electron-stub.sh");

ensureDevApp();
chmodSync(stub, 0o755);
const child = spawn("npx", ["electron-vite", "dev"], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_EXEC_PATH: stub },
});
child.on("exit", (code) => process.exit(code ?? 0));
