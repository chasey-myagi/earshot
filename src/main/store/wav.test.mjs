import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createPcmWavWriter, hasWavBody, repairSessionWavs, repairWavHeader } from "./wav.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function placeholderPlusPcm(path, pcmLen) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(0, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.alloc(pcmLen, 7)]));
}

test("repairWavHeader writes RIFF and data sizes after a crash leaves zeros", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-wav-"));
  const path = join(root, "mic.wav");
  placeholderPlusPcm(path, 320);
  const before = readFileSync(path);
  assert.equal(before.readUInt32LE(4), 36);
  assert.equal(before.readUInt32LE(40), 0);

  repairWavHeader(path);

  const after = readFileSync(path);
  assert.equal(after.readUInt32LE(4), after.length - 8);
  assert.equal(after.readUInt32LE(40), after.length - 44);
  assert.equal(after.length, 44 + 320);
});

test("repairWavHeader is a no-op for missing, short, or non-RIFF files", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-wav-"));
  const missing = join(root, "gone.wav");
  repairWavHeader(missing);
  assert.equal(existsSync(missing), false);

  const shortPath = join(root, "short.wav");
  const short = Buffer.from("RIFFWAVE");
  writeFileSync(shortPath, short);
  repairWavHeader(shortPath);
  assert.deepEqual(readFileSync(shortPath), short);

  const junkPath = join(root, "junk.wav");
  const junk = Buffer.alloc(64, 9);
  junk.write("XXXX", 0);
  writeFileSync(junkPath, junk);
  repairWavHeader(junkPath);
  assert.deepEqual(readFileSync(junkPath), junk);
});

test("hasWavBody is false at 44 bytes and true at 45", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-wav-"));
  const path = join(root, "mic.wav");
  writeFileSync(path, Buffer.alloc(44));
  assert.equal(hasWavBody(path), false);
  writeFileSync(path, Buffer.alloc(45));
  assert.equal(hasWavBody(path), true);
  assert.equal(hasWavBody(join(root, "missing.wav")), false);
});

test("createPcmWavWriter.close repairs the placeholder header", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-wav-"));
  const path = join(root, "mic.wav");
  const writer = createPcmWavWriter(path);
  writer.write(Buffer.alloc(160, 3));
  writer.close();
  const after = readFileSync(path);
  assert.equal(after.readUInt32LE(4), after.length - 8);
  assert.equal(after.readUInt32LE(40), after.length - 44);
});

test("repairSessionWavs repairs mic and system placeholders", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-wav-"));
  placeholderPlusPcm(join(root, "mic.wav"), 64);
  placeholderPlusPcm(join(root, "system.wav"), 96);
  repairSessionWavs(root);
  const mic = readFileSync(join(root, "mic.wav"));
  const system = readFileSync(join(root, "system.wav"));
  assert.equal(mic.readUInt32LE(4), mic.length - 8);
  assert.equal(mic.readUInt32LE(40), mic.length - 44);
  assert.equal(system.readUInt32LE(4), system.length - 8);
  assert.equal(system.readUInt32LE(40), system.length - 44);
});
