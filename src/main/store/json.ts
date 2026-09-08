import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";

export function writeJson(path: string, value: unknown): void {
  // A failed or partial write must leave the last committed document readable.
  // Keep honoring an explicitly read-only existing file when replacing it.
  if (existsSync(path)) accessSync(path, constants.W_OK);
  const pending = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(pending, path);
  } finally {
    try { rmSync(pending, { force: true }); } catch { /* preserve the original IO error */ }
  }
}

