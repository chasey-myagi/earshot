import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { VOICEPRINT_MODEL, findVoiceprintModel } from "./paths.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("findVoiceprintModel prefers packaged Resources over the repo models dir", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-paths-"));
  const resources = join(root, "Resources");
  const repo = join(root, "repo");
  mkdirSync(join(resources, "models"), { recursive: true });
  mkdirSync(join(repo, "models"), { recursive: true });
  writeFileSync(join(resources, "models", VOICEPRINT_MODEL), "packaged");
  writeFileSync(join(repo, "models", VOICEPRINT_MODEL), "dev");
  assert.equal(findVoiceprintModel({ resourcesPath: resources, repoRoot: repo }), join(resources, "models", VOICEPRINT_MODEL));
});

test("findVoiceprintModel uses repoRoot when packaged resources are absent", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-paths-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "models"), { recursive: true });
  writeFileSync(join(repo, "models", VOICEPRINT_MODEL), "dev");
  assert.equal(
    findVoiceprintModel({ resourcesPath: join(root, "missing"), repoRoot: repo }),
    join(repo, "models", VOICEPRINT_MODEL),
  );
});

test("findVoiceprintModel returns a real file or null when injected dirs are empty", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-paths-"));
  const found = findVoiceprintModel({
    resourcesPath: join(root, "missing-res"),
    repoRoot: join(root, "missing-repo"),
  });
  if (found) {
    assert.equal(found.includes(root), false);
    assert.equal(found.endsWith(VOICEPRINT_MODEL), true);
  } else {
    assert.equal(found, null);
  }
});
