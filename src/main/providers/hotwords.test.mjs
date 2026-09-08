import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeHotwords } from '../../shared/hotwords.ts';
import { createHotwordStore } from './hotwords.ts';

function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'earshot-hotwords-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'hotwords.json'); }
function cloud() {
  const calls = [], models = new Map(); let count = 0;
  return { calls, fetch: async (_url, init) => {
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body); assert.equal(body.model, 'speech-biasing'); calls.push(body.input);
    const { action, vocabulary_id, target_model } = body.input;
    if (action === 'create_vocabulary') { const id = `vocab-earshot-${++count}`; models.set(id, target_model); return Response.json({ output: { vocabulary_id: id } }); }
    if (action === 'query_vocabulary') return Response.json({ output: { status: 'OK', target_model: models.get(vocabulary_id) } });
    return Response.json({ output: {} });
  } };
}
test('hotwords deduplicate literal terms and validate provider language lengths and count', () => {
  assert.deepEqual(normalizeHotwords('矩阵起源\nEarshot，矩阵起源; New   York'), ['矩阵起源', 'Earshot', 'New York']);
  assert.throws(() => normalizeHotwords(Array.from({ length: 201 }, (_, i) => `word${i}`).join('\n')), /200/);
  assert.throws(() => normalizeHotwords('中文'.repeat(8)), /15/);
  assert.throws(() => normalizeHotwords('one two three four five six seven eight'), /7/);
  assert.throws(() => normalizeHotwords('hello\0world'), /热词/);
  assert.throws(() => normalizeHotwords(['hello']), /无效/);
});
test('saved terms apply inline only to supported Qwen model, and sync each Fun model separately', async t => {
  const path = fixture(t), api = cloud(), store = createHotwordStore(path, () => 'synthetic-key', api.fetch);
  const status = await store.save('矩阵起源\nEarshot');
  assert.equal(status.sync, 'ready');
  assert.deepEqual(api.calls.filter(call => call.action === 'create_vocabulary').map(call => call.target_model), ['fun-asr', 'fun-asr-realtime']);
  assert.deepEqual(store.parameters('qwen-audio-3.0-asr-flash-streaming'), { vocabulary: { 矩阵起源: 4, Earshot: 4 } });
  assert.deepEqual(store.parameters('qwen3-asr-flash-realtime'), {});
  assert.notEqual(store.parameters('fun-asr').vocabulary_id, store.parameters('fun-asr-realtime').vocabulary_id);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path, 'utf8').includes('synthetic-key'));
  const count = api.calls.length; await store.sync(); assert.equal(api.calls.length, count);
  const restored = createHotwordStore(path, () => 'synthetic-key', api.fetch);
  assert.equal(restored.status().sync, 'ready');
});
test('editing creates a new cloud version; unchanged save and clearing create no additional lists', async t => {
  const api = cloud(), store = createHotwordStore(fixture(t), () => 'key', api.fetch);
  await store.save('old'); const revision = store.revision();
  await store.save('new'); assert.notEqual(store.revision(), revision);
  assert.equal(api.calls.filter(call => call.action === 'create_vocabulary').length, 4);
  assert.equal(api.calls.filter(call => call.action === 'update_vocabulary').length, 0);
  await store.save('new');
  assert.equal(api.calls.filter(call => call.action === 'create_vocabulary').length, 4);
  await store.save(''); assert.deepEqual(store.parameters('fun-asr'), {}); assert.deepEqual(store.parameters('qwen-audio-3.0-asr-flash-streaming'), {});
  assert.equal(api.calls.filter(call => call.action === 'create_vocabulary').length, 4);
});
test('key replacement never sends old account vocabulary ids', async t => {
  let key = 'first-key'; const api = cloud(), store = createHotwordStore(fixture(t), () => key, api.fetch);
  await store.save('Earshot'); key = 'second-key';
  assert.deepEqual(store.parameters('fun-asr'), {});
  await store.sync(); assert.equal(api.calls.filter(call => call.action === 'create_vocabulary').length, 4);
});
test('offline terms persist and provider errors never reach renderer or disk', async t => {
  const path = fixture(t), secret = 'synthetic-sensitive-secret';
  const store = createHotwordStore(path, () => secret, async () => { throw new Error(`network ${secret}`); });
  const status = await store.save('Earshot'); assert.equal(status.sync, 'error');
  assert.ok(!JSON.stringify(status).includes(secret)); assert.ok(!readFileSync(path, 'utf8').includes(secret));
  assert.deepEqual(store.parameters('qwen-audio-3.0-asr-flash-streaming'), { vocabulary: { Earshot: 4 } });
  assert.deepEqual(store.parameters('fun-asr'), {});
});
test('failed readiness query keeps created id and never allocates duplicate list on retry', async t => {
  const api = cloud(); let failQuery = true;
  const store = createHotwordStore(fixture(t), () => 'key', async (...args) => {
    if (JSON.parse(args[1].body).input.action === 'query_vocabulary' && failQuery) return Response.json({ output: { status: 'UNDEPLOYED' } });
    return api.fetch(...args);
  });
  await store.save('Earshot'); assert.equal(store.status().sync, 'error');
  failQuery = false; await store.sync(); assert.equal(store.status().sync, 'ready');
  assert.equal(api.calls.filter(call => call.action === 'create_vocabulary').length, 2);
});
test('damaged local hotword file is visible and only explicit save replaces it', async t => {
  const path = fixture(t); writeFileSync(path, '{broken');
  const store = createHotwordStore(path, () => null);
  assert.equal(store.status().sync, 'error'); assert.equal(readFileSync(path, 'utf8'), '{broken');
  await store.save('Earshot'); assert.deepEqual(store.status().words, ['Earshot']);
});

test('request-bound vocabulary never uses the subsequently configured account', async t => {
  let key = 'account-a';
  const api = cloud(), store = createHotwordStore(fixture(t), () => key, api.fetch);
  await store.save('Earshot');
  key = 'account-b'; await store.sync();
  assert.deepEqual(store.parameters('fun-asr', 'account-a'), {});
  assert.deepEqual(store.parameters('fun-asr-realtime', 'account-a'), {});
  assert.ok(store.parameters('fun-asr', 'account-b').vocabulary_id);
});
