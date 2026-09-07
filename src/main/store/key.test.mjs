import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { KEY_FILE, readStoredKey, writeStoredKey } from "./key.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("writeStoredKey then readStoredKey returns the same key", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-key-"));
  writeStoredKey(root, "sk-12345678");
  assert.equal(readStoredKey(root), "sk-12345678");
});

test("readStoredKey returns null when the file is missing", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-key-"));
  assert.equal(readStoredKey(root), null);
});

test("writeStoredKey accepts a key of exactly 8 characters", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-key-"));
  writeStoredKey(root, "12345678");
  assert.equal(readStoredKey(root), "12345678");
});

test("readStoredKey ignores a too-short value", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-key-"));
  writeFileSync(join(root, KEY_FILE), "short\n");
  assert.equal(readStoredKey(root), null);
});

test("writeStoredKey rejects a short key", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-key-"));
  assert.throws(() => writeStoredKey(root, "short"), /不完整/);
  assert.equal(readStoredKey(root), null);
});

test("writeStoredKey is not group or world readable", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-key-"));
  writeStoredKey(root, "sk-12345678");
  chmodSync(join(root, KEY_FILE), 0o644);
  writeStoredKey(root, "sk-abcdefgh");
  assert.equal(statSync(join(root, KEY_FILE)).mode & 0o077, 0);
});
