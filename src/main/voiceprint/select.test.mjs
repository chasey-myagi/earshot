import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
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

test("clustersFromTurns refuses guessed speech ends", () => {
  assert.deepEqual(clustersFromTurns([
    { speaker: "小 A", tStartMs: 0, track: "other" },
    { speaker: "小 B", tStartMs: 8000, track: "other" },
    { speaker: "小 C", tStartMs: 9000, tEndMs: Infinity, track: "other" },
  ], 20000), []);
});

test('voice samples use distinct audible regions and exclude known overlapping speakers', async () => {
  const { selectVoiceSamples } = await import('./select.ts');
  root=mkdtempSync(join(tmpdir(),'earshot-quality-'));const path=join(root,'system.wav');writeToneWav(path,20);
  const audio=readFileSync(path);
  for(let i=0;i<20*16000;i++)audio.writeInt16LE(i<4*16000?0:Math.round(2000*Math.sin(i/20)),44+i*2);
  writeFileSync(path,audio);
  const cluster={speaker:'A',segments:[{startMs:0,endMs:20000}]};
  const samples=selectVoiceSamples(path,cluster,[cluster,{speaker:'B',segments:[{startMs:8000,endMs:12000}]}]);
  assert.ok(samples.length>=2 && samples.length<=3);
  assert.ok(samples.every(sample=>sample.segment.startMs>=4000));
  assert.ok(samples.every(sample=>sample.segment.endMs<=8000 || sample.segment.startMs>=12000));
  assert.ok(samples.every(sample=>sample.pcm.length>=2*16000*2));
});

test('duplicate overlapping source spans cannot be counted as separate voice evidence',async()=>{
  const {selectVoiceSamples}=await import('./select.ts');
  root=mkdtempSync(join(tmpdir(),'earshot-overlap-'));const path=join(root,'system.wav');writeToneWav(path,12);
  const audio=readFileSync(path);for(let i=0;i<12*16000;i++)audio.writeInt16LE(Math.round(2000*Math.sin(i/20)),44+i*2);writeFileSync(path,audio);
  const short={speaker:'A',segments:[{startMs:0,endMs:4000},{startMs:0,endMs:4000},{startMs:1000,endMs:4000}]};
  assert.equal(selectVoiceSamples(path,short,[short]).length,1);
  const long={speaker:'A',segments:[{startMs:0,endMs:8000},{startMs:4000,endMs:12000}]};
  const samples=selectVoiceSamples(path,long,[long]);assert.equal(samples.length,3);
  assert.ok(samples.every((sample,index)=>index===0||samples[index-1].segment.endMs<=sample.segment.startMs));
});

for(const quality of ['silence','clipped','overlap','other-track']) test(`signal screening handles ${quality}`,async()=>{
  const {voiceEvidence}=await import('./evidence.ts');
  root=mkdtempSync(join(tmpdir(),'earshot-signal-screen-'));const path=join(root,'system.wav');writeToneWav(path,8);
  const audio=readFileSync(path);for(let i=0;i<8*16000;i++)audio.writeInt16LE(quality==='silence'?0:quality==='clipped'?32767:Math.round(2000*Math.sin(i/20)),44+i*2);writeFileSync(path,audio);
  const cluster={speaker:'A',segments:[{startMs:0,endMs:8000}]};
  const others=['overlap','other-track'].includes(quality)?[{speaker:'B',track:quality==='other-track'?'you':'other',segments:[{startMs:0,endMs:8000}]}]:[];
  let calls=0;const result=await voiceEvidence(path,cluster,[cluster,...others],async()=>{calls++;return new Float32Array([1,0]);});
  assert.equal(result.status,quality==='other-track'?'ready':'insufficient');assert.equal(calls,quality==='other-track'?2:0);
});

// Controlled harmonic signals exercise gain and noise invariants. They are not
// claimed to be natural speech or an acceptance set for speaker identification.
function qualitySignal(path, { gain = 1, noise = 0, dc = 0, seconds = 12, clipped = false } = {}) {
  writeToneWav(path, seconds);
  const audio = readFileSync(path);
  let state = 123456789;
  for (let i = 0; i < seconds * 16000; i++) {
    state = (1664525 * state + 1013904223) >>> 0;
    const random = (state / 0x1_0000_0000) * 2 - 1;
    // Harmonics plus a deterministic slowly-varying envelope; no silent padding.
    const envelope = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(i / 16000 * 2 * Math.PI * 3));
    const voiced = envelope * (Math.sin(i / 16000 * 2 * Math.PI * 140)
      + 0.35 * Math.sin(i / 16000 * 2 * Math.PI * 280)
      + 0.15 * Math.sin(i / 16000 * 2 * Math.PI * 420));
    const value = clipped ? (i % 2 ? 32767 : -32768) : dc + gain * (3000 * voiced + noise * random);
    audio.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), 44 + i * 2);
  }
  writeFileSync(path, audio);
}

test('equivalent clean harmonic spans remain eligible after a 34dB gain reduction, with source PCM untouched', async () => {
  const { selectVoiceSamples } = await import('./select.ts');
  root = mkdtempSync(join(tmpdir(), 'earshot-gain-invariant-'));
  const normal = join(root, 'normal.wav'), quiet = join(root, 'quiet.wav');
  qualitySignal(normal); qualitySignal(quiet, { gain: 0.02 });
  const cluster = { speaker: 'controlled', segments: [{ startMs: 0, endMs: 12000 }] };
  const loudSamples = selectVoiceSamples(normal, cluster, [cluster]);
  const quietBefore = readFileSync(quiet);
  const quietSamples = selectVoiceSamples(quiet, cluster, [cluster]);
  assert.equal(loudSamples.length, 3);
  assert.equal(quietSamples.length, 3, 'same signal/SNR at lower gain must not be rejected as silence');
  assert.deepEqual(quietSamples.map(sample => sample.segment), loudSamples.map(sample => sample.segment));
  assert.deepEqual(readFileSync(quiet), quietBefore);
  for (const sample of quietSamples) assert.deepEqual(sample.pcm, quietBefore.subarray(44 + sample.segment.startMs * 32, 44 + sample.segment.endMs * 32));
});

for (const gain of [1, 0.02]) test(`noise-dominated harmonic spans remain rejected at gain ${gain}`, async () => {
  const { selectVoiceSamples } = await import('./select.ts');
  root = mkdtempSync(join(tmpdir(), 'earshot-noise-invariant-'));
  const path = join(root, 'noise.wav'); qualitySignal(path, { gain, noise: 14000 });
  const cluster = { speaker: 'controlled', segments: [{ startMs: 0, endMs: 12000 }] };
  assert.equal(selectVoiceSamples(path, cluster, [cluster]).length, 0, 'raising or lowering gain does not improve SNR');
});

for (const kind of ['quantization-floor', 'dc-only', 'hard-clipping', 'short']) test(`amplitude robustness still rejects ${kind}`, async () => {
  const { selectVoiceSamples } = await import('./select.ts');
  root = mkdtempSync(join(tmpdir(), 'earshot-quality-boundary-'));
  const path = join(root, 'input.wav');
  qualitySignal(path, { gain: kind === 'quantization-floor' ? 0.0003 : kind === 'dc-only' ? 0 : 1,
    dc: kind === 'dc-only' ? 5000 : 0, clipped: kind === 'hard-clipping', seconds: kind === 'short' ? 1.9 : 12 });
  const cluster = { speaker: 'controlled', segments: [{ startMs: 0, endMs: kind === 'short' ? 1900 : 12000 }] };
  assert.equal(selectVoiceSamples(path, cluster, [cluster]).length, 0);
});
