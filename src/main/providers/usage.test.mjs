import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUsageLedger, estimateCny, parseUsage } from './usage.ts';
const now = new Date(2026, 8, 8, 14).getTime();
const base = { id: 'task-1', at: now, model: 'fun-asr', kind: 'file-asr', measurement: 'provider', audioSeconds: 60 };
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'earshot-usage-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'usage.json'); }
test('usage parses actual provider units and rejects negative, string and unbounded fields', () => {
  assert.deepEqual(parseUsage({ payload: { usage: { duration: 12 } } }), { audioSeconds: 12 });
  assert.deepEqual(parseUsage({ usage: { prompt_tokens: 11, completion_tokens: 7 } }), { inputTokens: 11, outputTokens: 7 });
  assert.deepEqual(parseUsage({ usage: { input_tokens: 4, output_tokens: 2 } }), { inputTokens: 4, outputTokens: 2 });
  assert.deepEqual(parseUsage({ usage: { duration: -2, prompt_tokens: '11', completion_tokens: 1e30 } }), {});
  assert.deepEqual(parseUsage({ text: 'long text cannot stand in for tokens' }), {});
});
test('Beijing rate calculations preserve fractions and model tier boundaries', () => {
  assert.equal(estimateCny(base), 0.0132);
  assert.equal(estimateCny({ ...base, model: 'qwen-audio-3.0-asr-flash-streaming', audioSeconds: 3600 }), 1.188);
  assert.equal(estimateCny({ ...base, model: 'qwen3.8-flash', audioSeconds: undefined, inputTokens: 1000, outputTokens: 1000 }), 0.004);
  assert.equal(estimateCny({ ...base, model: 'qwen3.7-flash', inputTokens: 32768, outputTokens: 10 }), (32768 * .2 + 8) / 1e6);
  assert.equal(estimateCny({ ...base, model: 'qwen3.7-flash', inputTokens: 32769, outputTokens: 10 }), (32769 * .6 + 24) / 1e6);
  assert.equal(estimateCny({ ...base, model: 'qwen3.7-plus', inputTokens: 1000, outputTokens: 1000 }), .01);
  assert.equal(estimateCny({ ...base, model: 'unknown' }), null);
  assert.equal(estimateCny({ ...base, model: 'qwen3.8-flash' }), null);
});
test('one paid task remains one request across cumulative results, restarts and success retries', t => {
  const path = fixture(t), ledger = createUsageLedger(path, () => now);
  ledger.record({ ...base, measurement: 'local', outcome: 'uncertain', audioSeconds: 30 });
  ledger.record({ ...base, audioSeconds: 45 }); ledger.record(base);
  ledger.record({ ...base, measurement: 'local', audioSeconds: 63 });
  let summary = ledger.summary('month'); assert.equal(summary.requests, 1); assert.equal(summary.audioSeconds, 60); assert.equal(summary.unconfirmedRequests, 0);
  const restored = createUsageLedger(path, () => now); restored.record(base);
  assert.equal(restored.summary().requests, 1);
  restored.record({ ...base, id: 'task-2' }); summary = restored.summary(); assert.equal(summary.requests, 2); assert.equal(summary.audioSeconds, 120);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path, 'utf8').includes('task-1'));
});
test('unknown completion and missing token usage are reported without zero-charge claim', t => {
  const ledger = createUsageLedger(fixture(t), () => now);
  ledger.record({ ...base, id: 'unknown', model: 'qwen3.7-plus', audioSeconds: undefined, measurement: 'local', outcome: 'uncertain' });
  const summary = ledger.summary(); assert.equal(summary.unpricedRequests, 1); assert.equal(summary.unconfirmedRequests, 1);
  assert.equal(summary.actualBilling, 'unavailable'); assert.equal(summary.balanceCny, null); assert.match(summary.billingReason, /独立身份/);
});
test('calendar periods, retention, invalid data and accounting fields are bounded', t => {
  const ledger = createUsageLedger(fixture(t), () => now);
  ledger.record(base);
  ledger.record({ ...base, id: 'yesterday', at: now - 864e5 });
  ledger.record({ ...base, id: 'expired', at: now - 367 * 864e5 });
  ledger.record({ ...base, id: 'bad', audioSeconds: Infinity });
  ledger.record({ ...base, id: 'unknown-model', model: 'secret-injected-model' });
  assert.equal(ledger.summary('today').requests, 1); assert.equal(ledger.summary('month').requests, 2);
  assert.equal(ledger.summary('all').requests, 2); assert.throws(() => ledger.summary('bad'), /范围/);
});
test('ledger failures preserve transcript-facing nonthrowing record behavior and evidence', t => {
  const path = fixture(t); writeFileSync(path, '{broken');
  const ledger = createUsageLedger(path, () => now); assert.doesNotThrow(() => ledger.record(base));
  assert.match(ledger.summary().error, /无法读取/); assert.equal(readFileSync(path, 'utf8'), '{broken');
  const missingParent = createUsageLedger(join(path, 'missing.json'), () => now);
  assert.doesNotThrow(() => missingParent.record(base)); assert.match(missingParent.summary().error, /未能保存/);
});
test('event cap and duplicate persisted ids cannot inflate reported totals', t => {
  const path = fixture(t), events = Array.from({ length: 10000 }, (_, i) => ({ ...base, id: i.toString(16).padStart(64, '0') }));
  writeFileSync(path, JSON.stringify({ version: 1, trackingSince: now, capped: false, events }));
  const ledger = createUsageLedger(path, () => now); ledger.record({ ...base, id: 'new-call' });
  assert.equal(ledger.summary().requests, 10000); assert.equal(ledger.summary().capped, true);
  writeFileSync(path, JSON.stringify({ version: 1, trackingSince: now, events: [events[0], events[0]] }));
  assert.match(createUsageLedger(path, () => now).summary().error, /无法读取/);
});
