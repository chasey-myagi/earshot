import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const KEY_FILE = "key";

export function readStoredKey(dir: string): string | null {
  try {
    const key = readFileSync(join(dir, KEY_FILE), "utf8").trim();
    return key.length >= 8 ? key : null;
  } catch {
    return null;
  }
}

export function writeStoredKey(dir: string, raw: string): void {
  const key = raw.trim();
  if (key.length < 8) throw new Error("密钥看起来不完整");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, KEY_FILE);
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
