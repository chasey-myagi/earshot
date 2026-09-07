import assert from "node:assert/strict";
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { extractEmbedding, loadSherpa } from "./embed.ts";
import { MATCH_THRESHOLD, cosine } from "./match.ts";
import { findVoiceprintModel } from "./paths.ts";
import { readWavRange, s16leToFloat32, wavDurationMs } from "./wav.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SR_FILES = ["speaker1_a_cn_16k.wav", "speaker1_b_cn_16k.wav", "speaker2_a_cn_16k.wav"];

test("CAM++ same-speaker cosine beats other-speaker and clears the threshold", { timeout: 120_000 }, async (t) => {
  const modelPath = findVoiceprintModel({ repoRoot: ROOT });
  if (!modelPath) {
    t.skip("voiceprint model file missing; local calibration only");
    return;
  }
  try {
    loadSherpa();
    await Promise.all(SR_FILES.map((name) => ensureSrWav(name)));
  } catch (err) {
    t.skip(`voiceprint assets unavailable: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const [a1, a2, b1] = SR_FILES.map((name) => embedFile(modelPath, join(ROOT, "models/sr-data", name)));
  const same = cosine(a1, a2);
  const other = cosine(a1, b1);
  assert.equal(a1.length, 192);
  assert.ok(same > other, `same ${same} should beat other ${other}`);
  assert.ok(same > MATCH_THRESHOLD, `same ${same} should exceed ${MATCH_THRESHOLD}`);
  assert.ok(other < MATCH_THRESHOLD, `other ${other} should stay under ${MATCH_THRESHOLD}`);
});

function embedFile(modelPath, wavPath) {
  const pcm = readWavRange(wavPath, 0, wavDurationMs(wavPath));
  return extractEmbedding({ samples: s16leToFloat32(pcm), sampleRate: 16000, modelPath });
}

async function ensureSrWav(name) {
  const dir = join(ROOT, "models/sr-data");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  if (existsSync(dest) && statSync(dest).size > 1000) return dest;
  const url = `https://github.com/csukuangfj/sr-data/raw/main/test/3d-speaker/${name}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${name} download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return dest;
}
