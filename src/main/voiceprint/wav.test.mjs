import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { readWavRange, s16leToFloat32, wavDurationMs } from "./wav.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function writePcmWav({ path, samples, extraChunk }) {
  const dataBytes = samples.length * 2;
  const extra = extraChunk ?? Buffer.alloc(0);
  const headerSize = 12 + 8 + 16 + extra.length + 8;
  const buf = Buffer.alloc(headerSize + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  extra.copy(buf, 36);
  const dataAt = 36 + extra.length;
  buf.write("data", dataAt);
  buf.writeUInt32LE(dataBytes, dataAt + 4);
  for (let i = 0; i < samples.length; i += 1) buf.writeInt16LE(samples[i], dataAt + 8 + i * 2);
  const fd = openSync(path, "w");
  try {
    writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }
  return dataAt + 8;
}

test("readWavRange returns only the requested milliseconds of PCM past extra RIFF chunks", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-wav-"));
  const path = join(root, "system.wav");
  const extra = Buffer.alloc(16);
  extra.write("LIST", 0);
  extra.writeUInt32LE(8, 4);
  extra.write("adtl", 8);
  extra.write("xxxx", 12);
  const samples = new Int16Array(16000);
  for (let i = 0; i < samples.length; i += 1) samples[i] = i;
  writePcmWav({ path, samples, extraChunk: extra });

  const pcm = readWavRange(path, 100, 103);
  assert.equal(pcm.length, 16000 * 0.003 * 2);
  assert.equal(pcm.readInt16LE(0), 1600);
  assert.equal(pcm.readInt16LE(2), 1601);
  assert.equal(pcm.readInt16LE(4), 1602);
});

test("readWavRange throws on a non-RIFF WAVE file", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-wav-"));
  const path = join(root, "bad.wav");
  const fd = openSync(path, "w");
  try {
    writeSync(fd, Buffer.from("not a wave file!!!!"));
  } finally {
    closeSync(fd);
  }
  assert.throws(() => readWavRange(path, 0, 10), /not a WAVE file/);
});

test("readWavRange returns empty when the range is past the file or inverted", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-wav-"));
  const path = join(root, "tone.wav");
  writePcmWav({ path, samples: new Int16Array(16000) });
  assert.equal(readWavRange(path, 2000, 3000).length, 0);
  assert.equal(readWavRange(path, 100, 100).length, 0);
  assert.equal(readWavRange(path, 80, 40).length, 0);
});

test("readWavRange does not throw when the file tail is truncated", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-wav-"));
  const path = join(root, "cut.wav");
  const samples = new Int16Array(16000);
  for (let i = 0; i < samples.length; i += 1) samples[i] = i;
  const dataAt = writePcmWav({ path, samples });
  const fd = openSync(path, "r+");
  try {
    ftruncateSync(fd, dataAt + 6);
  } finally {
    closeSync(fd);
  }
  const pcm = readWavRange(path, 0, 1000);
  assert.equal(pcm.readInt16LE(0), 0);
  assert.equal(pcm.readInt16LE(2), 1);
  assert.equal(pcm.readInt16LE(4), 2);
});

test("s16leToFloat32 maps 0, 32767, and -32768", () => {
  const pcm = Buffer.alloc(6);
  pcm.writeInt16LE(0, 0);
  pcm.writeInt16LE(32767, 2);
  pcm.writeInt16LE(-32768, 4);
  const samples = s16leToFloat32(pcm);
  assert.equal(samples[0], 0);
  assert.equal(samples[1], 32767 / 32768);
  assert.equal(samples[2], -1);
});

test("wavDurationMs is 1000 for one second of 16 kHz mono", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-wav-"));
  const path = join(root, "sec.wav");
  writePcmWav({ path, samples: new Int16Array(16000) });
  assert.equal(wavDurationMs(path), 1000);
});
