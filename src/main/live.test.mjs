import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createLiveBuffer, markLiveDegraded, persistLive } from "./live.ts";
import { createRealtimeSession } from "./providers/realtime.ts";
import { createSessionStore } from "./store/sessions.ts";
import { sessionTranscript } from "./store/transcript.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("live buffer updates a partial then commits a final", () => {
  const buf = createLiveBuffer();
  const pending = buf.apply("other", {
    sentenceId: "3",
    text: "对",
    tStartMs: 12,
    final: false,
  });
  assert.equal(pending, null);
  assert.equal(buf.turns()[0].partial, true);
  assert.equal(buf.turns()[0].speaker, "对方");

  const committed = buf.apply("other", {
    sentenceId: "3",
    text: "对方说完了",
    tStartMs: 12,
    final: true,
  });
  assert.equal(committed?.text, "对方说完了");
  assert.equal(committed?.partial, undefined);
  assert.equal(buf.turns().length, 1);
  assert.equal(buf.turns()[0].partial, undefined);
});

test("live buffer keeps one partial per track", () => {
  const buf = createLiveBuffer();
  buf.apply("you", { sentenceId: "1", text: "我", tStartMs: 0, final: false });
  buf.apply("you", { sentenceId: "1", text: "我说", tStartMs: 0, final: false });
  assert.equal(buf.turns().length, 1);
  assert.equal(buf.turns()[0].text, "我说");
});

test("realtime failure preserves recording and its late error cannot change a recovered job", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-live-err-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  let onMessage;
  let onSocketError;
  createRealtimeSession({
    apiKey: "sk-test",
    onSentence: () => undefined,
    onError: (message) => markLiveDegraded(store, created.id, message),
    connect: () => ({
      send: () => undefined,
      close: () => undefined,
      onOpen: () => undefined,
      onMessage: (fn) => {
        onMessage = fn;
      },
      onError: (fn) => {
        onSocketError = fn;
      },
      onClose: () => undefined,
    }),
  });
  onMessage(JSON.stringify({ header: { event: "task-failed", error_message: "task failed" } }));
  const afterFail = store.readSession(created.id);
  assert.equal(afterFail.status, "recording");
  assert.equal(afterFail.jobs.live, "failed");
  assert.equal(afterFail.jobs.refined.status, "idle");

  store.patchJobs(created.id, { live: "running" });
  onSocketError(new Error("实时转写连接失败"));
  const afterSock = store.readSession(created.id);
  assert.equal(afterSock.status, "recording");
  assert.equal(afterSock.jobs.live, "running");
});

test("realtime onClose marks live failed and leaves the recording running", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-live-close-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  let fireClose;
  createRealtimeSession({
    apiKey: "sk-test",
    onSentence: () => undefined,
    onError: (message) => markLiveDegraded(store, created.id, message),
    connect: () => ({
      send: () => undefined,
      close: () => undefined,
      onOpen: () => undefined,
      onMessage: () => undefined,
      onError: () => undefined,
      onClose: (fn) => {
        fireClose = fn;
      },
    }),
  });
  fireClose();
  const afterClose = store.readSession(created.id);
  assert.equal(afterClose.status, "recording");
  assert.equal(afterClose.jobs.live, "failed");
  assert.equal(afterClose.jobs.refined.status, "idle");
});

test("finalize keeps live failed after markLiveDegraded", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-live-fin-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  markLiveDegraded(store, created.id, "实时转写已断开");
  store.finalize(created.id, "complete", { durationSec: 12 });
  const doc = store.readSession(created.id);
  assert.equal(doc.status, "complete");
  assert.equal(doc.jobs.live, "failed");
});

test("live buffer interleaves you and other by tStartMs with you first on a tie", () => {
  const buf = createLiveBuffer();
  buf.apply("you", { sentenceId: "1", text: "我", tStartMs: 100, final: false });
  buf.apply("other", { sentenceId: "2", text: "他", tStartMs: 50, final: false });
  assert.deepEqual(
    buf.turns().map((row) => [row.track, row.tStartMs, row.partial]),
    [
      ["other", 50, true],
      ["you", 100, true],
    ],
  );
  buf.apply("you", { sentenceId: "1", text: "我说完了", tStartMs: 100, final: true });
  buf.apply("other", { sentenceId: "2", text: "他说完了", tStartMs: 100, final: true });
  assert.deepEqual(
    buf.turns().map((row) => [row.track, row.text, row.partial]),
    [
      ["you", "我说完了", undefined],
      ["other", "他说完了", undefined],
    ],
  );
});

test("live buffer reset clears finals and partials", () => {
  const buf = createLiveBuffer();
  buf.apply("you", { sentenceId: "1", text: "我", tStartMs: 0, final: true });
  buf.apply("other", { sentenceId: "2", text: "他", tStartMs: 10, final: false });
  buf.reset();
  assert.deepEqual(buf.turns(), []);
});

test("persistLive writes a committed turn that sessionTranscript reads back", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-persist-"));
  const buf = createLiveBuffer();
  const committed = buf.apply("you", { sentenceId: "9", text: "我说完了", tStartMs: 40, final: true });
  persistLive(root, committed);
  appendFileSync(join(root, "live.jsonl"), "\nnot-json\n\n");
  const other = buf.apply("other", { sentenceId: "10", text: "对方", tStartMs: 80, final: true });
  persistLive(root, other);
  const turns = sessionTranscript(root, null, {});
  assert.deepEqual(
    turns.map((row) => ({ id: row.id, track: row.track, speaker: row.speaker, text: row.text })),
    [
      { id: committed.id, track: "you", speaker: "你", text: "我说完了" },
      { id: other.id, track: "other", speaker: "对方", text: "对方" },
    ],
  );
});

test("live buffer commits a final with an empty sentenceId", () => {
  const buf = createLiveBuffer();
  const committed = buf.apply("other", { sentenceId: "", text: "完", tStartMs: 0, final: true });
  assert.equal(committed?.text, "完");
  assert.equal(buf.turns().length, 1);
  assert.equal(buf.turns()[0].text, "完");
});

test("repeated final and late partial do not duplicate a committed live sentence", () => {
  const buffer = createLiveBuffer();
  const sentence = { sentenceId: "g1:1", text: "confirmed", tStartMs: 100, final: true };
  assert.ok(buffer.apply("you", sentence));
  assert.equal(buffer.apply("you", sentence), null);
  buffer.apply("you", { ...sentence, final: false, text: "stale draft" });
  assert.deepEqual(buffer.turns().map(row => row.text), ["confirmed"]);
});

test("disconnect discards unconfirmed drafts while keeping every confirmed sentence", () => {
  const buffer = createLiveBuffer();
  buffer.apply("you", { sentenceId: "1", text: "confirmed", tStartMs: 0, final: true });
  buffer.apply("other", { sentenceId: "1", text: "draft", tStartMs: 100, final: false });
  buffer.clearPartials();
  assert.deepEqual(buffer.turns().map(row => row.text), ["confirmed"]);
});
