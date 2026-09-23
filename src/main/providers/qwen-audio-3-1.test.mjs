import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MODELS, DICTATION_MODELS } from '../../shared/model-settings.ts';
import { DEFAULT_SHORTCUTS } from '../../shared/dictation.ts';
import { createShortcutSettings } from '../dictation/shortcuts.ts';
import { startDictationStream } from './dictation-stream.ts';
import { createHotwordStore } from './hotwords.ts';
import { createUsageLedger, estimateCny } from './usage.ts';

const V31 = 'qwen-audio-3.1-asr-flash-streaming', V30 = 'qwen-audio-3.0-asr-flash-streaming';
function dir(t, prefix) { const root = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test('Qwen Audio 3.1 is the default dictation model and listed first', () => {
  assert.equal(DEFAULT_MODELS.asr, V31);
  assert.equal(DICTATION_MODELS[0].id, V31);
});

test('settings saved with Qwen Audio 3.0 stay valid after the upgrade', t => {
  const root = dir(t, 'earshot-keys-');
  writeFileSync(join(root, 'shortcuts.json'), JSON.stringify({ ...DEFAULT_SHORTCUTS, delivery: 'preview', models: { asr: V30, polish: 'off' } }));
  const settings = createShortcutSettings({ root, register: () => true, unregister() {}, meeting() {}, dictation() {} });
  t.after(() => settings.close());
  assert.equal(settings.snapshot().prefs.delivery, 'preview');
  assert.equal(settings.snapshot().prefs.models.asr, V30);
});

test('Qwen Audio 3.1 streams over the inference socket with the 3.1 model id', () => {
  let opened, url; const sent = [], abort = new AbortController();
  const connect = target => { url = target; return { send: data => sent.push(Buffer.isBuffer(data) ? data : JSON.parse(data)), close() {}, onOpen: fn => opened = fn, onMessage() {}, onError() {}, onClose() {} }; };
  startDictationStream({ apiKey: 'fixture', model: V31, signal: abort.signal, connect });
  opened(); abort.abort();
  assert.equal(url, 'wss://dashscope.aliyuncs.com/api-ws/v1/inference');
  assert.equal(sent[0].header.action, 'run-task');
  assert.equal(sent[0].payload.model, V31);
});

test('saved hotwords are sent inline to Qwen Audio 3.1', async t => {
  const store = createHotwordStore(join(dir(t, 'earshot-hotwords-'), 'hotwords.json'), () => 'synthetic-key', async () => Response.json({ output: {} }));
  await store.save('矩阵起源\nEarshot');
  assert.deepEqual(store.parameters(V31), { vocabulary: { 矩阵起源: 4, Earshot: 4 } });
  assert.equal(store.status().models.find(model => model.model === V31)?.supported, true);
});

test('usage ledger keeps Qwen Audio 3.1 requests but leaves token pricing unknown', t => {
  const ledger = createUsageLedger(join(dir(t, 'earshot-usage-'), 'usage.json'), () => Date.now());
  const event = { id: 'task-31', at: Date.now(), model: V31, kind: 'dictation-asr', measurement: 'provider', outcome: 'succeeded', audioSeconds: 60 };
  ledger.record(event);
  assert.equal(ledger.summary().requests, 1);
  assert.equal(ledger.summary().unpricedRequests, 1);
  assert.equal(estimateCny(event), null);
  assert.equal(estimateCny({ ...event, model: V30, audioSeconds: 3600 }), 1.188);
});
