import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  applyNames,
  clusterName,
  mergeTurns,
  sessionTranscript,
  speakerFromId,
} from "./transcript.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("clusterName maps speaker 0 to 小 A", () => {
  assert.equal(clusterName(0), "小 A");
  assert.equal(clusterName(1), "小 B");
  assert.equal(speakerFromId("spk_0"), "小 A");
  assert.equal(speakerFromId(undefined), "对方");
});

test("mergeTurns sorts by tStartMs and keeps track", () => {
  const merged = mergeTurns(
    [{ id: "m", track: "you", speaker: "你", tStartMs: 80, text: "我" }],
    [
      { id: "s1", track: "other", speaker: "小 A", tStartMs: 20, text: "先" },
      { id: "s2", track: "other", speaker: "小 B", tStartMs: 80, text: "后" },
    ],
  );
  assert.deepEqual(
    merged.map((row) => row.id),
    ["s1", "m", "s2"],
  );
});

test("sessionTranscript prefers refined and applies names", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-tx-"));
  writeFileSync(
    join(root, "live.jsonl"),
    `${JSON.stringify({ id: "l1", track: "other", speaker: "对方", tStartMs: 0, text: "草稿" })}\n`,
  );
  writeFileSync(
    join(root, "refined-v1.json"),
    JSON.stringify({
      turns: [{ id: "r1", track: "other", speaker: "小 A", tStartMs: 10, text: "精修" }],
    }),
  );
  const turns = sessionTranscript(root, "refined-v1.json", { "小 A": "王明" });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].speaker, "王明");
  assert.equal(turns[0].text, "精修");
});

test("sessionTranscript falls back to live.jsonl", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-live-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "live.jsonl"),
    `${JSON.stringify({ id: "l1", track: "you", speaker: "你", tStartMs: 0, text: "你好" })}\n`,
  );
  const turns = sessionTranscript(root, null, {});
  assert.equal(turns[0].text, "你好");
  assert.equal(turns[0].track, "you");
});

test("applyNames only remaps known speakers", () => {
  const mapped = applyNames(
    [
      { id: "1", track: "other", speaker: "小 A", tStartMs: 0, text: "a" },
      { id: "2", track: "other", speaker: "小 B", tStartMs: 1, text: "b" },
    ],
    { "小 A": "王明" },
  );
  assert.equal(mapped[0].speaker, "王明");
  assert.equal(mapped[1].speaker, "小 B");
});

test("sessionTranscript drops a corrupt live.jsonl line and keeps the rest", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-tx-"));
  writeFileSync(
    join(root, "live.jsonl"),
    `${JSON.stringify({ id: "l1", track: "other", speaker: "对方", tStartMs: 0, text: "先" })}\nnot-json\n${JSON.stringify({ id: "l2", track: "you", speaker: "你", tStartMs: 10, text: "后" })}\n`,
  );
  const turns = sessionTranscript(root, null, {});
  assert.deepEqual(
    turns.map((row) => row.id),
    ["l1", "l2"],
  );
});

test("sessionTranscript returns [] when refined has no turns or illegal fields", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-tx-"));
  writeFileSync(join(root, "refined-v1.json"), JSON.stringify({}));
  assert.deepEqual(sessionTranscript(root, "refined-v1.json", {}), []);
  writeFileSync(
    join(root, "refined-v2.json"),
    JSON.stringify({
      turns: [
        { id: 1, text: "坏" },
        { id: "ok", track: "other", speaker: "小 A", tStartMs: 0, text: "好" },
      ],
    }),
  );
  const turns = sessionTranscript(root, "refined-v2.json", {});
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, "好");
});

test("clusterName maps 26 to 小 AA and treats negative or NaN as 对方", () => {
  assert.equal(clusterName(26), "小 AA");
  assert.equal(clusterName(-1), "对方");
  assert.equal(clusterName(Number.NaN), "对方");
});

test("mergeTurns keeps you before other when tStartMs ties", () => {
  const merged = mergeTurns(
    [{ id: "you", track: "you", speaker: "你", tStartMs: 40, text: "我" }],
    [{ id: "other", track: "other", speaker: "小 A", tStartMs: 40, text: "他" }],
  );
  assert.deepEqual(
    merged.map((row) => row.id),
    ["you", "other"],
  );
});
