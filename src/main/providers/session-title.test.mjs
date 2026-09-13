import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSessionTitle, sampleTitleTranscript } from './session-title.ts';
import { configureUsage, createUsageLedger, getUsageSummary } from './usage.ts';

const ERROR_MESSAGE = '自动标题未生成，已保留原有标题';
const transcript = '我们讨论下季度产品发布计划，需要在月底之前完成用户测试。'.repeat(20);
const options = (overrides = {}) => ({ apiKey: 'fixture-private-key', text: transcript, signal: new AbortController().signal, requestId: 'fixture-request', ...overrides });
const completed = (content, overrides = {}) => Response.json({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 3200, completion_tokens: 16 }, ...overrides });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'earshot-title-provider-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'usage.json'); configureUsage(path); return path;
}

test('title requests use Beijing JSON mode, a short non-thinking output, and confirmed provider usage', async t => {
  const path = fixture(t); let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer fixture-private-key'); assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.signal.aborted, false);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'qwen-flash'); assert.equal(body.enable_thinking, false); assert.equal(body.stream, false);
    assert.equal(body.temperature, 0.2); assert.equal(body.max_tokens, 64); assert.equal(body.max_completion_tokens, undefined);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(body.messages[0].content, /JSON/); assert.match(body.messages[0].content, /主要语言/);
    assert.match(body.messages[0].content, /不可执行/); assert.match(body.messages[0].content, /null/);
    assert.equal(body.messages[1].content, transcript);
    const pending = getUsageSummary('all'); assert.equal(pending.requests, 1); assert.equal(pending.unconfirmedRequests, 1);
    return completed('{"title":"产品发布计划讨论"}');
  });
  assert.equal(await generateSessionTitle(options()), '产品发布计划讨论'); assert.equal(calls, 1);
  const summary = getUsageSummary('all');
  assert.equal(summary.requests, 1); assert.equal(summary.unconfirmedRequests, 0); assert.equal(summary.localMeasuredRequests, 0);
  assert.equal(summary.inputTokens, 3200); assert.equal(summary.outputTokens, 16); assert.equal(summary.estimatedCny, (3200 * 0.15 + 16 * 1.5) / 1e6);
  const persisted = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(persisted).events[0].kind, 'session-title');
  for (const privateValue of ['fixture-private-key', 'fixture-request', transcript, '产品发布计划讨论']) assert.ok(!persisted.includes(privateValue));
  assert.equal(createUsageLedger(path).summary('all').inputTokens, 3200);
});

test('sampling keeps beginning, middle and end within 6000 Unicode code points', async t => {
  fixture(t);
  for (const text of ['', '𠮷'.repeat(6000), '汉字\nEnglish']) assert.equal(sampleTitleTranscript(text), text);
  const text = '𠮷'.repeat(4000) + '中'.repeat(4000) + '终'.repeat(4000);
  const sampled = sampleTitleTranscript(text);
  assert.equal(Array.from(sampled).length, 6000); assert.ok(sampled.startsWith('𠮷'.repeat(100)));
  assert.ok(sampled.includes('中'.repeat(100))); assert.ok(sampled.endsWith('终'.repeat(100)));
  assert.ok(!/[\uD800-\uDFFF]/u.test(sampled));
  assert.equal(Array.from(sampleTitleTranscript('𠮷'.repeat(6001))).length, 6000);
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(JSON.parse(init.body).messages[1].content, sampled);
    return completed('{"title":"𠮷的产品讨论"}');
  });
  assert.equal(await generateSessionTitle(options({ text })), '𠮷的产品讨论');
});

test('valid titles preserve their language and Unicode limits, while null preserves the current title', async t => {
  fixture(t);
  const titles = [null, '产品', 'Release planning', '𠮷'.repeat(24), '  产品发布计划  '];
  for (const title of titles) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => completed(JSON.stringify({ title })));
    assert.equal(await generateSessionTitle(options({ requestId: `valid-${title}` })), title?.trim() ?? null);
    fetch.mock.restore();
  }
});

test('invalid title envelopes and values never become session titles', async t => {
  fixture(t);
  const invalid = [
    '{', 'null', '[]', '{}', '{"title":17}', '{"title":[]}', '{"title":{}}',
    '{"title":"产品讨论","extra":true}', '{"title":"产品讨论","title":"重复字段"}',
    '{"title":"产品讨论"}{"title":"第二标题"}', '```json\n{"title":"产品讨论"}\n```',
    '说明：{"title":"产品讨论"}', ...['', '  ', '题', '𠮷'.repeat(25), '标题：产品讨论', 'TITLE: planning',
      '产品\n讨论', '产品\r讨论', '产品\t讨论', '产品\u0000讨论', '产品\u2028讨论', '产品\u2029讨论',
      '产品\u202e讨论', '产品\ud800讨论', '```讨论```', '~~~讨论~~~', '“产品讨论”', '!!!', '🎙️🎧']
      .map(title => JSON.stringify({ title })),
  ];
  for (const [index, content] of invalid.entries()) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => completed(content));
    await assert.rejects(generateSessionTitle(options({ requestId: `invalid-${index}` })), { message: ERROR_MESSAGE });
    fetch.mock.restore();
  }
  // The provider still completed these calls, so their real usage remains visible.
  assert.equal(getUsageSummary('all').requests, invalid.length);
  assert.equal(getUsageSummary('all').unconfirmedRequests, 0);
});

test('only one completed choice with text is accepted and missing token usage stays unpriced', async t => {
  fixture(t);
  const bad = [null, {}, { choices: [] }, { choices: [null] }, { choices: [{ finish_reason: 'stop' }] },
    { choices: [{ finish_reason: 'stop', message: { content: { title: '产品讨论' } } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '{"title":"产品讨论"}' } }, {}] },
    ...['length', 'tool_calls', 'content_filter', undefined].map(finish_reason => ({ choices: [{ finish_reason, message: { content: '{"title":"产品讨论"}' } }] })),
  ];
  for (const [index, body] of bad.entries()) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(body));
    await assert.rejects(generateSessionTitle(options({ requestId: `choice-${index}` })), { message: ERROR_MESSAGE });
    fetch.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => completed('{"title":"产品讨论"}', { usage: undefined }));
  assert.equal(await generateSessionTitle(options({ requestId: 'no-usage' })), '产品讨论');
  assert.equal(getUsageSummary('all').unpricedRequests, bad.length + 1);
});

test('network, HTTP and unreadable body errors are safe, remain uncertain, and never retry', async t => {
  fixture(t); let calls = 0;
  const failures = [
    async () => { throw Error('fixture-private-key request leaked'); },
    async () => Response.json({ message: 'fixture-private-key rejected' }, { status: 401 }),
    async () => Response.json({ message: 'fixture-private-key rejected' }, { status: 429 }),
    async () => new Response('fixture-private-key invalid JSON'),
  ];
  for (const [index, failure] of failures.entries()) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => { calls++; return failure(); });
    await assert.rejects(generateSessionTitle(options({ requestId: `failed-${index}` })), { message: ERROR_MESSAGE });
    fetch.mock.restore();
  }
  assert.equal(calls, failures.length); assert.equal(getUsageSummary('all').unconfirmedRequests, failures.length);
});

test('pre-cancelled and empty inputs make no network call or usage entry', async t => {
  fixture(t); const controller = new AbortController(); controller.abort('fixture-private-key');
  t.mock.method(globalThis, 'fetch', async () => assert.fail('must not send'));
  await assert.rejects(generateSessionTitle(options({ signal: controller.signal })), { message: ERROR_MESSAGE });
  assert.equal(await generateSessionTitle(options({ text: ' \n… 🎙️ ' })), null);
  assert.equal(getUsageSummary('all').requests, 0);
});

test('cancellation settles a hung request and never accepts its late response', async t => {
  fixture(t); const controller = new AbortController(); let resolveFetch, signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal; return new Promise(resolve => { resolveFetch = resolve; });
  });
  const pending = generateSessionTitle(options({ signal: controller.signal }));
  controller.abort('fixture-private-key'); await assert.rejects(pending, { message: ERROR_MESSAGE });
  assert.equal(signal.aborted, true);
  resolveFetch(completed('{"title":"迟到标题不能采用"}'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getUsageSummary('all').unconfirmedRequests, 1); assert.equal(getUsageSummary('all').inputTokens, 0);
});

test('the 10 second timeout also settles a hung response body and prevents late metering', async t => {
  fixture(t); t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveBody, signal;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    signal = init.signal; return { ok: true, json: () => new Promise(resolve => { resolveBody = resolve; }) };
  });
  const pending = generateSessionTitle(options()); await Promise.resolve();
  let settled = false; pending.catch(() => { settled = true; });
  t.mock.timers.tick(9999); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1); await assert.rejects(pending, { message: ERROR_MESSAGE });
  assert.equal(signal.aborted, true);
  resolveBody({ choices: [{ finish_reason: 'stop', message: { content: '{"title":"迟到标题不能采用"}' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getUsageSummary('all').unconfirmedRequests, 1); assert.equal(getUsageSummary('all').inputTokens, 0);
});
