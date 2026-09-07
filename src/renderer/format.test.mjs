import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatClock,
  formatDurationLong,
  formatDurationShort,
  formatListWhen,
  formatTurnClock,
  isSameDay,
  pad2,
} from "./format.ts";

test("pad2 zero-pads", () => {
  assert.equal(pad2(3), "03");
  assert.equal(pad2(12), "12");
});

test("isSameDay compares calendar day", () => {
  const now = new Date(2026, 7, 19, 15);
  assert.equal(isSameDay(new Date(2026, 7, 19, 8).toISOString(), now), true);
  assert.equal(isSameDay(new Date(2026, 7, 18, 23, 59).toISOString(), now), false);
});

test("formatListWhen labels today and yesterday", () => {
  const now = new Date(2026, 7, 19, 12);
  assert.equal(formatListWhen(new Date(2026, 7, 19, 8).toISOString(), now), "今天");
  assert.equal(formatListWhen(new Date(2026, 7, 18, 20).toISOString(), now), "昨天");
  assert.equal(formatListWhen(new Date(2026, 7, 10, 20).toISOString(), now), "8月10日");
});

test("formatDurationShort and long", () => {
  assert.equal(formatDurationShort(45), "45 秒");
  assert.equal(formatDurationShort(60), "1 分");
  assert.equal(formatDurationShort(120), "2 分");
  assert.equal(formatDurationShort(3600), "1 小时");
  assert.equal(formatDurationShort(3660), "1 小时 1 分");
  assert.equal(formatDurationShort(-3), "0 秒");
  assert.equal(formatDurationLong(120), "2 分钟");
  assert.equal(formatDurationLong(3660), "1 小时 1 分钟");
});

test("formatClock omits hours under one hour", () => {
  assert.equal(formatClock(65), "01:05");
  assert.equal(formatClock(3665), "1:01:05");
});

test("formatTurnClock uses session start when provided", () => {
  const startedAt = new Date(2026, 7, 19, 10).toISOString();
  assert.equal(formatTurnClock(15 * 60_000, startedAt), "10:15");
  assert.equal(formatTurnClock(65_000, null), formatClock(65));
});
