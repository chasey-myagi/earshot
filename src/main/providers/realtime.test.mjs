import assert from "node:assert/strict";
import { test } from "node:test";
import { createRealtimeSession, parseRealtimeMessage } from "./realtime.ts";

test("parseRealtimeMessage reads a final sentence", () => {
  const parsed = parseRealtimeMessage(
    JSON.stringify({
      header: { event: "result-generated" },
      payload: {
        output: {
          sentence: { sentence_id: 8, text: " 你好 ", begin_time: 240, sentence_end: true },
        },
      },
    }),
  );
  assert.equal(parsed.event, "result-generated");
  assert.deepEqual(parsed.sentence, {
    sentenceId: "8",
    text: "你好",
    tStartMs: 240,
    final: true,
  });
});

test("parseRealtimeMessage ignores heartbeat and surfaces task-failed", () => {
  const beat = parseRealtimeMessage(
    JSON.stringify({
      header: { event: "result-generated" },
      payload: { output: { sentence: { heartbeat: true, text: "" } } },
    }),
  );
  assert.equal(beat.sentence, undefined);
  const failed = parseRealtimeMessage(
    JSON.stringify({ header: { event: "task-failed", error_message: "bad key" } }),
  );
  assert.equal(failed.error, "bad key");
});

test("createRealtimeSession waits for task-started before sending pcm", () => {
  const sent = [];
  let onMessage;
  const session = createRealtimeSession({
    apiKey: "sk-test",
    onSentence: () => undefined,
    connect: () => ({
      send: (data) => sent.push(data),
      close: () => undefined,
      onOpen: (fn) => fn(),
      onMessage: (fn) => {
        onMessage = fn;
      },
      onError: () => undefined,
      onClose: () => undefined,
    }),
  });
  session.sendPcm(Buffer.from([1, 2]));
  assert.equal(
    sent.some((row) => Buffer.isBuffer(row)),
    false,
  );
  onMessage(JSON.stringify({ header: { event: "task-started" } }));
  assert.equal(
    sent.some((row) => Buffer.isBuffer(row)),
    true,
  );
  const run = JSON.parse(sent.find((row) => typeof row === "string"));
  assert.equal(run.header.action, "run-task");
  assert.equal(run.payload.model, "fun-asr-realtime");
  session.stop();
});

test("createRealtimeSession drops queued pcm above 1000 frames before task-started", () => {
  const sent = [];
  let onMessage;
  const session = createRealtimeSession({
    apiKey: "sk-test",
    onSentence: () => undefined,
    connect: () => ({
      send: (data) => sent.push(data),
      close: () => undefined,
      onOpen: (fn) => fn(),
      onMessage: (fn) => {
        onMessage = fn;
      },
      onError: () => undefined,
      onClose: () => undefined,
    }),
  });
  for (let i = 0; i < 1005; i += 1) session.sendPcm(Buffer.from([i % 256]));
  onMessage(JSON.stringify({ header: { event: "task-started" } }));
  const pcm = sent.filter((row) => Buffer.isBuffer(row));
  assert.equal(pcm.length, 1000);
  assert.deepEqual([...pcm[0]], [5]);
  assert.deepEqual([...pcm[999]], [1004 % 256]);
  session.stop();
});

test("createRealtimeSession stop after start sends finish-task and closes", () => {
  const sent = [];
  let closed = 0;
  let onMessage;
  const session = createRealtimeSession({
    apiKey: "sk-test",
    onSentence: () => undefined,
    connect: () => ({
      send: (data) => sent.push(data),
      close: () => {
        closed += 1;
      },
      onOpen: (fn) => fn(),
      onMessage: (fn) => {
        onMessage = fn;
      },
      onError: () => undefined,
      onClose: () => undefined,
    }),
  });
  onMessage(JSON.stringify({ header: { event: "task-started" } }));
  session.stop();
  const finish = sent
    .filter((row) => typeof row === "string")
    .map((row) => JSON.parse(row))
    .find((row) => row.header?.action === "finish-task");
  assert.equal(finish.header.action, "finish-task");
  assert.equal(closed, 1);
});

test("createRealtimeSession ignores sendPcm after stop", () => {
  const sent = [];
  const session = createRealtimeSession({
    apiKey: "sk-test",
    onSentence: () => undefined,
    connect: () => ({
      send: (data) => sent.push(data),
      close: () => undefined,
      onOpen: (fn) => fn(),
      onMessage: () => undefined,
      onError: () => undefined,
      onClose: () => undefined,
    }),
  });
  session.stop();
  const before = sent.length;
  session.sendPcm(Buffer.from([1, 2, 3]));
  assert.equal(sent.length, before);
});

test("createRealtimeSession stop before task-started only closes", () => {
  const sent = [];
  let closed = 0;
  const session = createRealtimeSession({
    apiKey: "sk-test",
    onSentence: () => undefined,
    connect: () => ({
      send: (data) => sent.push(data),
      close: () => {
        closed += 1;
      },
      onOpen: (fn) => fn(),
      onMessage: () => undefined,
      onError: () => undefined,
      onClose: () => undefined,
    }),
  });
  session.stop();
  assert.equal(
    sent.some((row) => typeof row === "string" && row.includes("finish-task")),
    false,
  );
  assert.equal(closed, 1);
});

test("createRealtimeSession does not queue empty PCM", () => {
  const sent = [];
  let onMessage;
  const session = createRealtimeSession({
    apiKey: "sk-test",
    onSentence: () => undefined,
    connect: () => ({
      send: (data) => sent.push(data),
      close: () => undefined,
      onOpen: (fn) => fn(),
      onMessage: (fn) => {
        onMessage = fn;
      },
      onError: () => undefined,
      onClose: () => undefined,
    }),
  });
  session.sendPcm(Buffer.alloc(0));
  session.sendPcm(Buffer.from([9, 8]));
  onMessage(JSON.stringify({ header: { event: "task-started" } }));
  const pcm = sent.filter((row) => Buffer.isBuffer(row));
  assert.equal(pcm.length, 1);
  assert.deepEqual([...pcm[0]], [9, 8]);
  session.stop();
});

test("createRealtimeSession swallows illegal JSON and empty text", () => {
  const sentences = [];
  const errors = [];
  let onMessage;
  createRealtimeSession({
    apiKey: "sk-test",
    onSentence: (row) => sentences.push(row),
    onError: (message) => errors.push(message),
    connect: () => ({
      send: () => undefined,
      close: () => undefined,
      onOpen: () => undefined,
      onMessage: (fn) => {
        onMessage = fn;
      },
      onError: () => undefined,
      onClose: () => undefined,
    }),
  });
  assert.doesNotThrow(() => onMessage("not-json{"));
  onMessage(
    JSON.stringify({
      header: { event: "result-generated" },
      payload: { output: { sentence: { sentence_id: 1, text: "   ", sentence_end: true } } },
    }),
  );
  assert.deepEqual(sentences, []);
  assert.deepEqual(errors, []);
});

test("createRealtimeSession unexpected close reports onError", () => {
  const errors = [];
  let fireClose;
  const session = createRealtimeSession({
    apiKey: "sk-test",
    onSentence: () => undefined,
    onError: (message) => errors.push(message),
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
  assert.deepEqual(errors, ["实时转写已断开"]);
  session.stop();
  fireClose();
  assert.deepEqual(errors, ["实时转写已断开"]);
});

test("realtime readiness comes from task-started, and an unexpected close rejects late results", () => {
  const handlers = {};
  const rows = [];
  const states = [];
  const session = createRealtimeSession({ apiKey: "fixture", onSentence: row => rows.push(row),
    onReady: () => states.push("ready"), onError: () => states.push("lost"),
    connect: () => ({ send() {}, close() {},
      onOpen: fn => { handlers.open = fn; }, onMessage: fn => { handlers.message = fn; },
      onError: fn => { handlers.error = fn; }, onClose: fn => { handlers.close = fn; },
    }),
  });
  handlers.open();
  assert.deepEqual(states, []);
  handlers.message(JSON.stringify({ header: { event: "task-started" } }));
  assert.deepEqual(states, ["ready"]);
  handlers.close();
  handlers.error(new Error("late error"));
  handlers.message(JSON.stringify({ header: { event: "result-generated" }, payload: { output: {
    sentence: { text: "late", begin_time: 0, sentence_id: 1, sentence_end: true },
  }}}));
  assert.deepEqual(states, ["ready", "lost"]);
  assert.deepEqual(rows, []);
  session.stop();
});

test("reconnected transcript starts at the first retained audio frame even after queue overflow", () => {
  let message;
  const rows = [];
  const session = createRealtimeSession({ apiKey: "fixture", onSentence: row => rows.push(row),
    connect: () => ({ send() {}, close() {}, onOpen() {}, onError() {}, onClose() {},
      onMessage: fn => { message = fn; },
    }),
  });
  for (let i = 0; i < 1005; i++) session.sendPcm(Buffer.alloc(320), 30000 + i * 10);
  message(JSON.stringify({ header: { event: "task-started" } }));
  message(JSON.stringify({ header: { event: "result-generated" }, payload: { output: {
    sentence: { text: "after reconnect", begin_time: 200, sentence_id: 1, sentence_end: true },
  }}}));
  assert.equal(rows[0].tStartMs, 30250);
  session.stop();
});

test("socket send failures are reported once without escaping into audio capture", () => {
  let message;
  const errors = [];
  const session = createRealtimeSession({ apiKey: "fixture", onSentence() {}, onError: value => errors.push(value),
    connect: () => ({ send(data) { if (Buffer.isBuffer(data)) throw new Error("socket unavailable"); },
      close() {}, onOpen() {}, onError() {}, onClose() {}, onMessage: fn => { message = fn; },
    }),
  });
  message(JSON.stringify({ header: { event: "task-started" } }));
  assert.doesNotThrow(() => session.sendPcm(Buffer.alloc(320)));
  assert.equal(errors.length, 1);
  assert.doesNotThrow(() => session.sendPcm(Buffer.alloc(320)));
  assert.equal(errors.length, 1);
  session.stop();
});

test("a connection that never starts becomes retryable while a stopped connection stays quiet", async () => {
  const errors = [];
  const connect = () => ({ send() {}, close() {}, onOpen() {}, onError() {}, onClose() {}, onMessage() {} });
  const session = createRealtimeSession({ apiKey: "fixture", onSentence() {}, connect,
    onError: value => errors.push(value), readyTimeoutMs: 5,
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(errors.length, 1);
  session.stop();
  const stopped = createRealtimeSession({ apiKey: "fixture", onSentence() {}, connect,
    onError: value => errors.push(value), readyTimeoutMs: 5,
  });
  stopped.stop();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(errors.length, 1);
});

test("sentences without provider ids keep partial-final identity and separate later sentences", () => {
  let message;
  const rows = [];
  const session = createRealtimeSession({ apiKey: "fixture", onSentence: row => rows.push(row),
    connect: () => ({ send() {}, close() {}, onOpen() {}, onError() {}, onClose() {},
      onMessage: fn => { message = fn; },
    }),
  });
  for (const [text, final] of [["first", false], ["first final", true], ["second", true]]) {
    message(JSON.stringify({ header: { event: "result-generated" }, payload: { output: {
      sentence: { text, begin_time: 0, sentence_end: final },
    }}}));
  }
  assert.equal(rows[0].sentenceId, rows[1].sentenceId);
  assert.notEqual(rows[1].sentenceId, rows[2].sentenceId);
  session.stop();
});

// Fixed recovery contract, recorded RED before implementation (2026-09-08).
test('recovery contract: run-task explicitly keeps continuous silence alive', () => {
  const sent = []; let open;
  const session = createRealtimeSession({ apiKey: 'synthetic', onSentence() {}, connect: () => ({
    send: data => sent.push(data), close() {}, onOpen: fn => open = fn, onMessage() {}, onError() {}, onClose() {},
  }) });
  try { open(); assert.equal(JSON.parse(sent[0]).payload.parameters.heartbeat, true); }
  finally { session.stop(); }
});

test('provider failures classify actionable causes and never carry raw text into structured diagnostics', () => {
  const cases=[['InvalidApiKey','auth',false],['InsufficientBalance','quota',false],['InvalidParameter','invalid-request',false],
    ['RequestTimeout','provider-timeout',true],['Throttling','rate-limit',true],['InternalError','server',true],['ServiceUnavailable','server',true]];
  for(const [code,category,retryable] of cases){
    const parsed=parseRealtimeMessage(JSON.stringify({header:{event:'task-failed',error_code:code,error_message:'fixture text sk-secret'}}));
    assert.deepEqual(parsed.failure,{category,retryable,providerCode:code});
  }
  const parsed=parseRealtimeMessage(JSON.stringify({header:{event:'task-failed',error_code:'sk-private-token',error_message:'private transcript'}}));
  assert.deepEqual(parsed.failure,{category:'provider',retryable:false});
});

// C1 fixed regression: explicit provider codes outrank ambiguous explanation text.
test('C1 contract: known throttling codes remain retryable despite quota words, while account failures remain terminal', () => {
  for (const [code, message, category, retryable] of [
    ['Throttling.RateQuota', 'Too many requests', 'rate-limit', true],
    ['Throttling', 'Request rate quota exceeded temporarily', 'rate-limit', true],
    ['InsufficientBalance', 'Account quota exhausted; rate limit request rejected', 'quota', false],
    ['InvalidApiKey', 'Rate quota request rejected', 'auth', false],
  ]) {
    const parsed = parseRealtimeMessage(JSON.stringify({ header: { event: 'task-failed', error_code: code, error_message: message } }));
    assert.deepEqual(parsed.failure, { category, retryable, providerCode: code }, code);
  }
});
