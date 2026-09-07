import assert from "node:assert/strict";
import { test } from "node:test";
import { glanceRecordingEqual, shareSnapshotTurns } from "./snapshotPick.ts";
import { scrollBehavior, shouldStickToBottom } from "./scroll.ts";

test("shouldStickToBottom when near bottom", () => {
  assert.equal(shouldStickToBottom(900, 1000, 100, 48), true);
  assert.equal(shouldStickToBottom(800, 1000, 100, 48), false);
});

test("scrollBehavior respects reduced motion", () => {
  assert.equal(scrollBehavior(true), "auto");
  assert.equal(scrollBehavior(false), "smooth");
});

test("glanceRecordingEqual ignores unchanged tail", () => {
  const base = {
    sessionId: "s1",
    elapsedSec: 10,
    glanceVisible: true,
    turns: [{ id: "t1", track: "you", speaker: "你", tStartMs: 0, text: "你好" }],
  };
  const same = { ...base, turns: [...base.turns] };
  const changed = {
    ...base,
    turns: [{ ...base.turns[0], text: "你好啊" }],
  };
  assert.equal(glanceRecordingEqual(base, same), true);
  assert.equal(glanceRecordingEqual(base, changed), false);
});

test("glanceRecordingEqual detects new turn", () => {
  const a = {
    sessionId: "s1",
    elapsedSec: 10,
    glanceVisible: true,
    turns: [{ id: "t1", track: "you", speaker: "你", tStartMs: 0, text: "a" }],
  };
  const b = {
    ...a,
    turns: [
      ...a.turns,
      { id: "t2", track: "other", speaker: "对方", tStartMs: 1000, text: "b" },
    ],
  };
  assert.equal(glanceRecordingEqual(a, b), false);
});

test("glanceRecordingEqual detects non-tail partial text change", () => {
  const otherFinal = { id: "live-other-s7", track: "other", speaker: "对方", tStartMs: 9000, text: "好。" };
  const a = {
    sessionId: "s1",
    elapsedSec: 10,
    glanceVisible: true,
    turns: [
      { id: "live-you-s1", track: "you", speaker: "你", tStartMs: 8000, text: "我先说", partial: true },
      otherFinal,
    ],
  };
  const b = {
    ...a,
    turns: [
      { ...a.turns[0], text: "我先说结论,这个方案" },
      otherFinal,
    ],
  };
  assert.equal(glanceRecordingEqual(a, b), false);
});

test("glanceRecordingEqual is false for null vs a recording and for elapsed or glance-only changes", () => {
  const rec = {
    sessionId: "s1",
    elapsedSec: 10,
    glanceVisible: true,
    turns: [{ id: "t1", track: "you", speaker: "你", tStartMs: 0, text: "你好" }],
  };
  assert.equal(glanceRecordingEqual(null, rec), false);
  assert.equal(glanceRecordingEqual(rec, { ...rec, elapsedSec: 11 }), false);
  assert.equal(glanceRecordingEqual(rec, { ...rec, glanceVisible: false }), false);
});

test("glanceRecordingEqual detects partial to final on non-tail row", () => {
  const otherFinal = { id: "live-other-s7", track: "other", speaker: "对方", tStartMs: 9000, text: "好。" };
  const partial = {
    id: "live-you-s1",
    track: "you",
    speaker: "你",
    tStartMs: 8000,
    text: "我先说结论,这个方案",
    partial: true,
  };
  const final = { ...partial, partial: undefined };
  const recPartial = { sessionId: "s1", elapsedSec: 10, glanceVisible: true, turns: [partial, otherFinal] };
  const recFinal = { sessionId: "s1", elapsedSec: 10, glanceVisible: true, turns: [final, otherFinal] };
  assert.equal(glanceRecordingEqual(recPartial, recFinal), false);
});

test("glance updates connection and stop progress even when no transcript arrives", () => {
  const recording = { sessionId: "s1", elapsedSec: 5, glanceVisible: true, turns: [],
    connection: "connected", phase: "recording" };
  assert.equal(glanceRecordingEqual(recording, { ...recording, connection: "disconnected" }), false);
  assert.equal(glanceRecordingEqual(recording, { ...recording, phase: "stopping" }), false);
  assert.equal(glanceRecordingEqual(recording, { ...recording, storageWarning: "状态暂未保存" }), false);
});

test("stream updates retain unchanged row identity across IPC snapshots", () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, track: "you", speaker: "你",
    tStartMs: i * 1000, text: `row ${i}`, ...(i === 11 ? { partial: true } : {}),
  }));
  const previous = { recording: { sessionId: "current", turns }, selected: { id: "current", turns } };
  const next = structuredClone(previous);
  next.recording.turns[11].text = "updated partial";
  next.selected.turns[11].text = "updated partial";
  const shared = shareSnapshotTurns(previous, next);
  assert.equal(shared.selected.turns[0], previous.selected.turns[0]);
  assert.notEqual(shared.selected.turns[11], previous.selected.turns[11]);
  assert.equal(shared.selected.turns[11].text, "updated partial");
  assert.equal(shared.selected.turns, shared.recording.turns);
  assert.equal(shareSnapshotTurns(shared, structuredClone(shared)).selected.turns, shared.selected.turns);
});

test("switching between history and live with colliding row ids cannot leak text, and stopping replaces the draft", () => {
  const row = (text, partial = false) => ({ id: "shared-id", track: "other", speaker: "小 A", tStartMs: 0, text, partial });
  const first = { recording: { sessionId: "A", turns: [row("A draft", true)] }, selected: { id: "A", turns: [row("A draft", true)] } };
  const history = shareSnapshotTurns(first, {
    recording: { sessionId: "A", turns: [row("A growing", true)] }, selected: { id: "B", turns: [row("B history")] },
  });
  assert.equal(history.selected.turns[0].text, "B history");
  assert.equal(history.recording.turns[0].text, "A growing");
  const current = shareSnapshotTurns(history, { recording: history.recording, selected: { id: "A", turns: [] } });
  assert.equal(current.selected.turns[0].text, "A growing");
  const stopped = shareSnapshotTurns(current, { recording: null, selected: { id: "A", turns: [row("A refined")] } });
  assert.equal(stopped.selected.turns[0].text, "A refined");
  assert.equal(stopped.selected.turns[0].partial, false);
  assert.equal(history.selected.turns[0].text, "B history");
});
