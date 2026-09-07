import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { VOICEPRINT_MODEL, VOICEPRINT_MODEL_URL, fetchVoiceprintModel } from "./fetch-voiceprint-model.mjs";

const digest = data => createHash("sha256").update(data).digest("hex");
let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("fetchVoiceprintModel downloads the CAM++ onnx into destDir", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-vp-"));
  let url = "";
  const dest = await fetchVoiceprintModel({
    destDir: root,
    expectedSha256: digest("onnx-bytes"),
    fetchImpl: async (input) => {
      url = String(input);
      return new Response(Buffer.from("onnx-bytes"), { status: 200 });
    },
  });
  assert.equal(url, VOICEPRINT_MODEL_URL);
  assert.match(VOICEPRINT_MODEL_URL, /speaker-recongition-models/);
  assert.equal(dest, join(root, VOICEPRINT_MODEL));
  assert.equal(readFileSync(dest, "utf8"), "onnx-bytes");
});

test("fetchVoiceprintModel reuses an existing model file", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-vp-"));
  const existing = join(root, VOICEPRINT_MODEL);
  writeFileSync(existing, Buffer.alloc(1_000_001));
  let called = 0;
  const dest = await fetchVoiceprintModel({
    destDir: root,
    expectedSha256: digest(Buffer.alloc(1_000_001)),
    fetchImpl: async () => {
      called += 1;
      return new Response("no", { status: 500 });
    },
  });
  assert.equal(called, 0);
  assert.equal(dest, existing);
  assert.equal(existsSync(existing), true);
});

test("fetchVoiceprintModel throws on HTTP 500 and leaves no tmp file", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-vp-"));
  await assert.rejects(
    () =>
      fetchVoiceprintModel({
        destDir: root,
        fetchImpl: async () => new Response("no", { status: 500 }),
      }),
    /voiceprint model download failed: 500/,
  );
  assert.equal(existsSync(join(root, VOICEPRINT_MODEL)), false);
  assert.equal(existsSync(join(root, `${VOICEPRINT_MODEL}.tmp`)), false);
});

test("fetchVoiceprintModel re-downloads when the existing file does not match its checksum", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-vp-"));
  const existing = join(root, VOICEPRINT_MODEL);
  writeFileSync(existing, Buffer.alloc(1_000_000));
  let called = 0;
  const dest = await fetchVoiceprintModel({
    destDir: root,
    expectedSha256: digest("replaced"),
    fetchImpl: async () => {
      called += 1;
      return new Response(Buffer.from("replaced"), { status: 200 });
    },
  });
  assert.equal(called, 1);
  assert.equal(dest, existing);
  assert.equal(readFileSync(dest, "utf8"), "replaced");
});

for (const existing of [false, true]) {
  test(`checksum mismatch rejects a download and preserves any existing file (${existing})`, async () => {
    root = mkdtempSync(join(tmpdir(), "earshot-vp-checksum-"));
    const path = join(root, VOICEPRINT_MODEL);
    if (existing) writeFileSync(path, "previous-model");
    await assert.rejects(fetchVoiceprintModel({ destDir: root, force: true, expectedSha256: digest("trusted-model"),
      fetchImpl: async () => new Response("corrupt-download") }), /checksum mismatch/);
    assert.equal(existsSync(`${path}.tmp`), false);
    if (existing) assert.equal(readFileSync(path, "utf8"), "previous-model");
    else assert.equal(existsSync(path), false);
  });
}
