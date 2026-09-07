import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAME_SAMPLES, PCM_RATE, encodeCaptureFrames, floatToS16le, resampleFloat } from "../../shared/pcm.ts";

test("floatToS16le clips and encodes a silent buffer", () => {
  const pcm = Buffer.from(floatToS16le(new Float32Array([0, 1, -1, 2])));
  assert.equal(pcm.readInt16LE(0), 0);
  assert.equal(pcm.readInt16LE(2), 0x7fff);
  assert.equal(pcm.readInt16LE(4), -0x8000);
  assert.equal(pcm.readInt16LE(6), 0x7fff);
});

test("resampleFloat halves a 2x sample rate", () => {
  const input = new Float32Array([0, 1, 0, 1]);
  const out = resampleFloat(input, 32000, 16000);
  assert.equal(out.length, 2);
  assert.equal(out[0], 0);
});

test("default capture frame is 100 to 130ms at 16kHz", () => {
  const ms = (FRAME_SAMPLES / PCM_RATE) * 1000;
  assert.equal(PCM_RATE, 16000);
  assert.ok(ms >= 100 && ms <= 130);
});

test("encodeCaptureFrames tags you frames and keeps leftover samples", () => {
  const pending = new Float32Array([0, 1]);
  const incoming = new Float32Array([-1, 0.5, 0.25]);
  const { frames, rest } = encodeCaptureFrames("you", pending, incoming, 4);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].track, "you");
  const pcm = Buffer.from(frames[0].pcm);
  assert.equal(pcm.readInt16LE(0), 0);
  assert.equal(pcm.readInt16LE(2), 0x7fff);
  assert.equal(pcm.readInt16LE(4), -0x8000);
  assert.equal(pcm.readInt16LE(6), Math.round(0.5 * 0x7fff));
  assert.equal(rest.length, 1);
  assert.equal(rest[0], 0.25);
});
