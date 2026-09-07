import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { addVoiceprint, hasAnyVoiceprint, readVoiceBook } from "./book.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("addVoiceprint round-trips a float32 embedding as base64 JSON", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-book-"));
  assert.equal(hasAnyVoiceprint(root), false);
  const embedding = new Float32Array([0.5, -1, 0.25]);
  addVoiceprint(root, "王明", embedding);
  assert.equal(hasAnyVoiceprint(root), true);
  const book = readVoiceBook(root);
  assert.equal(book.length, 1);
  assert.equal(book[0].name, "王明");
  assert.deepEqual(Array.from(book[0].embeddings[0]), [0.5, -1, 0.25]);
  const raw = JSON.parse(readFileSync(join(root, "people-voice.json"), "utf8"));
  assert.equal(typeof raw.people["王明"][0], "string");
  assert.equal(Buffer.from(raw.people["王明"][0], "base64").length, 12);
});

test("hasAnyVoiceprint is false when people-voice.json is not JSON", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-book-"));
  writeFileSync(join(root, "people-voice.json"), "not-json");
  assert.equal(hasAnyVoiceprint(root), false);
});

test("addVoiceprint keeps the 3 newest embeddings per person", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-book-"));
  addVoiceprint(root, "王明", new Float32Array([1]));
  addVoiceprint(root, "王明", new Float32Array([2]));
  addVoiceprint(root, "王明", new Float32Array([3]));
  addVoiceprint(root, "王明", new Float32Array([4]));
  const values = readVoiceBook(root)[0].embeddings.map((row) => row[0]);
  assert.deepEqual(values, [2, 3, 4]);
});
