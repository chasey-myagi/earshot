import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createSessionStore } from "../store/sessions.ts";
import { processSession } from "./post.ts";
import {
  abortRecordingStart,
  cancelJob,
  finishRecordingJobs,
  queuePost,
  recoverStuckJobs,
  settleSession,
} from "./orchestrate.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function placeholderPlusPcm(path, pcmLen) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(0, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.alloc(pcmLen, 7)]));
}

function writeToneWav(path, seconds) {
  const samples = seconds * 16000;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  writeFileSync(path, buf);
}

function makeQueue(store, extras = {}) {
  return {
    store,
    jobsInFlight: new Set(),
    jobAbort: new Map(),
    jobFailReasons: new Map(),
    apiKey: "sk-test",
    process: async () => undefined,
    ...extras,
  };
}

test("queuePost refuses a session already in flight", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-queue-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  const queue = makeQueue(store);
  queue.jobsInFlight.add(created.id);
  const result = queuePost(queue, created.id, "all");
  assert.deepEqual(result, { ok: false, error: "正在处理" });
});

test("queuePost refuses without an api key", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-queue-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  const result = queuePost(makeQueue(store, { apiKey: null }), created.id, "all");
  assert.deepEqual(result, { ok: false, error: "没有密钥不能开始", code: "no_key" });
});

test("queuePost refuses an unknown session", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-queue-"));
  const store = createSessionStore(root);
  const result = queuePost(makeQueue(store), "missing", "all");
  assert.deepEqual(result, { ok: false, error: "找不到这场会" });
});

function flushJobs() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(fn, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if (fn()) return;
    await flushJobs();
  }
  throw new Error("timed out");
}

test("queuePost success clears in-flight after process resolves and can enqueue again", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-queue-ok-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  const seen = [];
  let changes = 0;
  const queue = makeQueue(store, {
    onChange: () => {
      changes += 1;
    },
    process: async (opts) => {
      seen.push({
        sessionId: opts.sessionId,
        mode: opts.mode,
        hasSignal: Boolean(opts.signal),
        hasOnFail: typeof opts.onFail === "function",
      });
    },
  });
  const result = queuePost(queue, created.id, "all");
  assert.deepEqual(result, { ok: true });
  assert.equal(queue.jobsInFlight.has(created.id), true);
  assert.equal(queue.jobAbort.has(created.id), true);
  await flushJobs();
  assert.deepEqual(seen, [{ sessionId: created.id, mode: "all", hasSignal: true, hasOnFail: true }]);
  assert.equal(queue.jobsInFlight.has(created.id), false);
  assert.equal(queue.jobAbort.has(created.id), false);
  assert.equal(changes >= 1, true);
  assert.deepEqual(queuePost(queue, created.id, "speakers"), { ok: true });
  await flushJobs();
});

test("queuePost clears in-flight after process rejects and records onFail", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-queue-fail-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  const queue = makeQueue(store, {
    process: async (opts) => {
      opts.onFail("refined", "网络不通");
      throw new Error("boom");
    },
  });
  assert.deepEqual(queuePost(queue, created.id, "all"), { ok: true });
  await flushJobs();
  assert.equal(queue.jobsInFlight.has(created.id), false);
  assert.equal(queue.jobAbort.has(created.id), false);
  assert.deepEqual(queue.jobFailReasons.get(created.id), { refined: "网络不通" });
  assert.deepEqual(queuePost(queue, created.id, "all"), { ok: true });
  await flushJobs();
});

test("cancelJob aborts the in-flight process then allows enqueue again", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-queue-cancel-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  writeToneWav(join(store.sessionDir(created.id), "system.wav"), 1);
  let seenSignal;
  const queue = makeQueue(store, {
    process: (opts) => {
      seenSignal = opts.signal;
      return processSession({
        ...opts,
        transcribe: async ({ signal }) => {
          await new Promise((_, reject) => {
            const fail = () => {
              const err = new Error("已取消");
              err.name = "AbortError";
              reject(err);
            };
            if (signal?.aborted) fail();
            else signal.addEventListener("abort", fail, { once: true });
          });
        },
      });
    },
  });
  assert.deepEqual(queuePost(queue, created.id, "all"), { ok: true });
  assert.deepEqual(cancelJob(queue, created.id), { ok: true });
  await waitUntil(() => !queue.jobsInFlight.has(created.id));
  assert.equal(seenSignal.aborted, true);
  const doc = store.readSession(created.id);
  assert.equal(doc.jobs.refined.status, "canceled");
  assert.equal(doc.jobs.speakers.status, "canceled");
  assert.deepEqual(queue.jobFailReasons.get(created.id), undefined);
  assert.deepEqual(queuePost(queue, created.id, "speakers"), { ok: true });
  await waitUntil(() => queue.jobsInFlight.has(created.id));
  assert.deepEqual(cancelJob(queue, created.id), { ok: true });
  await waitUntil(() => !queue.jobsInFlight.has(created.id));
});

test("cancelJob without an in-flight job returns 没有正在处理的任务", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-queue-cancel-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  assert.deepEqual(cancelJob(makeQueue(store), created.id), {
    ok: false,
    error: "没有正在处理的任务",
  });
});

test("finishRecordingJobs stop queues all after settle", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-finish-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  writeToneWav(join(store.sessionDir(created.id), "mic.wav"), 1);
  const calls = [];
  const queue = makeQueue(store, {
    process: async (opts) => {
      calls.push({ id: opts.sessionId, mode: opts.mode });
    },
  });
  settleSession(store, created.id, created.startedAt, 0);
  finishRecordingJobs(queue, created.id, "stop");
  await flushJobs();
  assert.equal(store.readSession(created.id).status, "complete");
  assert.deepEqual(calls, [{ id: created.id, mode: "all" }]);
});

test("finishRecordingJobs quit marks refined and speakers failed without processing", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-finish-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  let called = 0;
  const queue = makeQueue(store, {
    process: async () => {
      called += 1;
    },
  });
  settleSession(store, created.id, created.startedAt, 0);
  finishRecordingJobs(queue, created.id, "quit");
  await flushJobs();
  const doc = store.readSession(created.id);
  assert.equal(called, 0);
  assert.equal(doc.jobs.refined.status, "failed");
  assert.equal(doc.jobs.speakers.status, "failed");
});

test("finishRecordingJobs crash marks incomplete then still queues", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-finish-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  writeToneWav(join(store.sessionDir(created.id), "mic.wav"), 1);
  const calls = [];
  const queue = makeQueue(store, {
    process: async (opts) => {
      calls.push(opts.mode);
    },
  });
  settleSession(store, created.id, created.startedAt, 1);
  finishRecordingJobs(queue, created.id, "crash");
  await flushJobs();
  assert.equal(store.readSession(created.id).status, "incomplete");
  assert.deepEqual(calls, ["all"]);
});

test("recoverStuckJobs only requeues non-recording sessions with a running job", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-stuck-"));
  const store = createSessionStore(root);
  const recording = store.createRecording();
  store.patchJobs(recording.id, { refined: { status: "running" } });

  const completeAll = store.createRecording();
  store.finalize(completeAll.id, "complete");
  store.patchJobs(completeAll.id, { refined: { status: "running" } });

  const completeSpeakers = store.createRecording();
  store.finalize(completeSpeakers.id, "complete");
  store.patchJobs(completeSpeakers.id, { speakers: { status: "running" } });

  const completeIdle = store.createRecording();
  store.finalize(completeIdle.id, "complete");

  const incomplete = store.createRecording();
  store.finalize(incomplete.id, "incomplete");
  store.patchJobs(incomplete.id, { refined: { status: "running" } });

  const calls = [];
  const queue = makeQueue(store, {
    process: async (opts) => {
      calls.push({ id: opts.sessionId, mode: opts.mode });
    },
  });
  recoverStuckJobs(queue);
  await Promise.resolve();
  assert.deepEqual(
    calls.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: completeAll.id, mode: "all" },
      { id: completeSpeakers.id, mode: "speakers" },
      { id: incomplete.id, mode: "all" },
    ].sort((a, b) => a.id.localeCompare(b.id)),
  );
});

test("recoverStuckJobs does nothing without an api key", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-stuck-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  store.patchJobs(created.id, { refined: { status: "running" } });
  let called = 0;
  recoverStuckJobs(
    makeQueue(store, {
      apiKey: null,
      process: async () => {
        called += 1;
      },
    }),
  );
  await Promise.resolve();
  assert.equal(called, 0);
});

test("settleSession repairs wav headers and marks complete when code is 0", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-settle-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  const dir = store.sessionDir(created.id);
  placeholderPlusPcm(join(dir, "mic.wav"), 16000 * 2);
  settleSession(store, created.id, created.startedAt, 0);
  const doc = store.readSession(created.id);
  assert.equal(doc.status, "complete");
  assert.equal(doc.durationSec >= 1, true);
  const wav = readFileSync(join(dir, "mic.wav"));
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
});

test("settleSession marks incomplete when capture exits non-zero", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-settle-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  settleSession(store, created.id, created.startedAt, 1);
  assert.equal(store.readSession(created.id).status, "incomplete");
});

test("abortRecordingStart stops realtime, clears live, and deletes an empty session", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-abort-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  writeFileSync(join(store.sessionDir(created.id), "mic.wav"), Buffer.alloc(44));
  let stopped = 0;
  let live = { sessionId: created.id };
  abortRecordingStart({
    store,
    sessionId: created.id,
    stopRealtime: () => {
      stopped += 1;
    },
    clearLive: () => {
      live = null;
    },
  });
  assert.equal(stopped, 1);
  assert.equal(live, null);
  assert.equal(store.readSession(created.id), null);
});

test("abortRecordingStart keeps a session that already has audio as incomplete", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-abort-"));
  const store = createSessionStore(root);
  const created = store.createRecording();
  writeToneWav(join(store.sessionDir(created.id), "mic.wav"), 2);
  abortRecordingStart({
    store,
    sessionId: created.id,
    stopRealtime: () => undefined,
    clearLive: () => undefined,
  });
  const doc = store.readSession(created.id);
  assert.equal(doc.status, "incomplete");
  assert.equal(doc.jobs.live, "idle");
});
