import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { existsSync, mkdirSync, renameSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VOICEPRINT_MODEL = "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx";
export const VOICEPRINT_MODEL_SHA256 = "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11";
export const VOICEPRINT_MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx";

export async function fetchVoiceprintModel(opts = {}) {
  const destDir = opts.destDir ?? join(ROOT, "models");
  const dest = join(destDir, VOICEPRINT_MODEL);
  const expectedSha256 = opts.expectedSha256 ?? VOICEPRINT_MODEL_SHA256;
  const checksum = path => createHash("sha256").update(readFileSync(path)).digest("hex");
  if (!opts.force && existsSync(dest) && checksum(dest) === expectedSha256) return dest;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(VOICEPRINT_MODEL_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`voiceprint model download failed: ${res.status}`);
  mkdirSync(destDir, { recursive: true });
  const tmp = `${dest}.tmp`;
  try {
    if (res.body && typeof res.body.getReader === "function") {
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    } else {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    }
    if (checksum(tmp) !== expectedSha256) throw new Error("voiceprint model checksum mismatch");
    renameSync(tmp, dest);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore leftover tmp
    }
    throw err;
  }
  return dest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchVoiceprintModel().then((dest) => {
    process.stdout.write(`${dest}\n`);
  }, (err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
