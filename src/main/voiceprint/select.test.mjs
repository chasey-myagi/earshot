import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { parseSpeakerClusters, selectClusterPcm, clustersFromTurns } from "./select.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function writeToneWav(path, seconds) {
  const samples = seconds * 16000;
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
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
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i += 1) {
    const second = Math.floor(i / 16000);
    buf.writeInt16LE(second, 44 + i * 2);
  }
  const fd = openSync(path, "w");
  try {
    writeSync(fd, buf);
  } finally {
    closeSync(fd);
  }
}

test("selectClusterPcm concatenates the longest segments into 6-10 seconds", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-sel-"));
  const path = join(root, "system.wav");
  writeToneWav(path, 16);
  const pcm = selectClusterPcm(path, {
    speaker: "小 A",
    segments: [
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 7000 },
      { startMs: 8000, endMs: 12000 },
      { startMs: 13000, endMs: 13200 },
    ],
  });
  assert.equal(pcm.length, 9 * 16000 * 2);
  assert.equal(pcm.readInt16LE(0), 2);
  assert.equal(pcm.readInt16LE((5 * 16000 - 1) * 2), 6);
  assert.equal(pcm.readInt16LE(5 * 16000 * 2), 8);
  assert.equal(pcm.readInt16LE((9 * 16000 - 1) * 2), 11);
});

test("selectClusterPcm trims a long stretch to 10 seconds", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-sel-"));
  const path = join(root, "system.wav");
  writeToneWav(path, 16);
  const pcm = selectClusterPcm(path, {
    speaker: "小 A",
    segments: [{ startMs: 0, endMs: 15000 }],
  });
  assert.equal(pcm.length, 10 * 16000 * 2);
  assert.equal(pcm.readInt16LE(0), 0);
  assert.equal(pcm.readInt16LE((10 * 16000 - 1) * 2), 9);
});

test("clustersFromTurns prefers tEndMs so gaps are not enrolled", () => {
  const clusters = clustersFromTurns(
    [
      { speaker: "小 A", tStartMs: 0, tEndMs: 1000, track: "other" },
      { speaker: "小 B", tStartMs: 3000, tEndMs: 4000, track: "other" },
      { speaker: "小 A", tStartMs: 8000, tEndMs: 8500, track: "other" },
    ],
    9000,
  );
  assert.deepEqual(clusters, [
    {
      speaker: "小 A",
      segments: [
        { startMs: 0, endMs: 1000 },
        { startMs: 8000, endMs: 8500 },
      ],
    },
    { speaker: "小 B", segments: [{ startMs: 3000, endMs: 4000 }] },
  ]);
});

test("parseSpeakerClusters drops missing clusters and illegal segments", () => {
  assert.deepEqual(parseSpeakerClusters(null), []);
  assert.deepEqual(parseSpeakerClusters({ clusters: { speaker: "小 A" } }), []);
  assert.deepEqual(
    parseSpeakerClusters({
      clusters: [
        { speaker: "", segments: [{ startMs: 0, endMs: 1000 }] },
        { speaker: "小 A" },
        { speaker: "小 B", segments: [{ startMs: 10, endMs: 10 }] },
        { speaker: "小 C", segments: [{ startMs: 0, endMs: 800 }] },
      ],
    }),
    [{ speaker: "小 C", segments: [{ startMs: 0, endMs: 800 }] }],
  );
});

test("clustersFromTurns uses the next turn as the segment end", () => {
  const clusters = clustersFromTurns(
    [
      { speaker: "小 A", tStartMs: 0, track: "other" },
      { speaker: "小 B", tStartMs: 2000, track: "other" },
      { speaker: "小 A", tStartMs: 5000, track: "other" },
      { speaker: "你", tStartMs: 100, track: "you" },
    ],
    9000,
  );
  assert.deepEqual(clusters, [
    {
      speaker: "小 A",
      segments: [
        { startMs: 0, endMs: 2000 },
        { startMs: 5000, endMs: 9000 },
      ],
    },
    { speaker: "小 B", segments: [{ startMs: 2000, endMs: 5000 }] },
  ]);
});
