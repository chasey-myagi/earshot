import assert from "node:assert/strict";
import { test } from "node:test";
import { workBarMessage } from "./workBar.ts";

test("workBarMessage only mentions running jobs", () => {
  assert.equal(workBarMessage({ live: "done", refined: "running", speakers: "idle" }), "正在转写录音");
  assert.equal(workBarMessage({ live: "done", refined: "idle", speakers: "running" }), "正在区分说话人");
  assert.equal(
    workBarMessage({ live: "done", refined: "running", speakers: "running" }),
    "正在转写录音并区分说话人",
  );
});

test("workBarMessage falls back to 正在处理 when nothing is running", () => {
  assert.equal(workBarMessage({ live: "idle", refined: "idle", speakers: "idle" }), "正在处理");
  assert.equal(workBarMessage({ live: "done", refined: "done", speakers: "done" }), "正在处理");
  assert.equal(workBarMessage({ live: "failed", refined: "failed", speakers: "failed" }), "正在处理");
  assert.equal(workBarMessage({ live: "done", refined: "failed", speakers: "idle" }).includes("正在转写录音"), false);
});
