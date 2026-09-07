import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionSideHint } from "./sessionSide.ts";

test("sessionSideHint shows failure beside session row", () => {
  assert.equal(sessionSideHint({ live: "done", refined: "failed", speakers: "running" }), "处理未完成");
});

test("sessionSideHint is null while jobs run or when done", () => {
  assert.equal(sessionSideHint({ live: "done", refined: "running", speakers: "idle" }), null);
  assert.equal(sessionSideHint({ live: "done", refined: "done", speakers: "done" }), null);
});

test("sessionSideHint shows 处理未完成 when only speakers failed", () => {
  assert.equal(sessionSideHint({ live: "done", refined: "done", speakers: "failed" }), "处理未完成");
});

test("sessionSideHint ignores a live-only failure", () => {
  assert.equal(sessionSideHint({ live: "failed", refined: "done", speakers: "done" }), null);
});
