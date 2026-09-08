import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configureHotwords, saveHotwords } from './hotwords.ts';
import { configureUsage, getUsageSummary } from './usage.ts';
import { startDictationStream } from './dictation-stream.ts';
import { createRealtimeSession } from './realtime.ts';
import { transcribeFile } from './file-asr.ts';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'earshot-provider-settings-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  configureUsage(join(dir, 'usage.json'));
  const modelById = new Map(); let count = 0;
  configureHotwords(join(dir, 'hotwords.json'), () => 'fixture-key', async (_url, init) => {
    const input = JSON.parse(init.body).input;
    if (input.action === 'create_vocabulary') { const id = `vocab-earshot-${++count}`; modelById.set(id, input.target_model); return Response.json({ output: { vocabulary_id: id } }); }
    if (input.action === 'query_vocabulary') return Response.json({ output: { status: 'OK', target_model: modelById.get(input.vocabulary_id) } });
    return Response.json({ output: {} });
  });
  return dir;
}
function socket() { let open, message; const sent = []; return { sent, connect: () => ({ send: data => sent.push(Buffer.isBuffer(data) ? Buffer.from(data) : JSON.parse(data)), close() {}, onOpen: fn => open = fn, onMessage: fn => message = fn, onError() {}, onClose() {} }), open: () => open(), message: value => message(JSON.stringify(value)) }; }
function wav(path) { const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(32036, 4); header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(32000, 40); writeFileSync(path, Buffer.concat([header, Buffer.alloc(32000)])); }

test('actual dictation wire includes inline hotwords and cumulative usage is metered once', async t => {
  fixture(t); await saveHotwords('矩阵起源');
  const os = socket(), abort = new AbortController(); t.after(() => abort.abort());
  const stream = startDictationStream({ apiKey: 'fixture-key', model: 'qwen-audio-3.0-asr-flash-streaming', signal: abort.signal, connect: os.connect });
  os.open(); assert.deepEqual(os.sent[0].payload.parameters.vocabulary, { 矩阵起源: 4 });
  os.message({ header: { event: 'task-started' } }); stream.send(Buffer.alloc(32000));
  os.message({ header: { event: 'result-generated' }, payload: { usage: { duration: 2 }, output: { sentence: { sentence_id: 1, sentence_end: true, begin_time: 0, text: '矩阵' } } } });
  os.message({ header: { event: 'result-generated' }, payload: { usage: { duration: 3 }, output: { sentence: { sentence_id: 2, sentence_end: true, begin_time: 500, text: '起源' } } } });
  const result = stream.finish(); os.message({ header: { event: 'task-finished' } }); assert.equal(await result, '矩阵起源');
  const summary = getUsageSummary('today'); assert.equal(summary.requests, 1); assert.equal(summary.audioSeconds, 3); assert.equal(summary.localMeasuredRequests, 0); assert.equal(summary.unconfirmedRequests, 0);
});
test('meeting realtime uses correct compiled model vocabulary and meters sent PCM', async t => {
  fixture(t); await saveHotwords('Earshot'); const os = socket();
  const session = createRealtimeSession({ apiKey: 'fixture-key', onSentence() {}, connect: os.connect });
  t.after(() => session.stop()); os.open(); assert.equal(os.sent[0].payload.parameters.vocabulary_id, 'vocab-earshot-2');
  os.message({ header: { event: 'task-started' } }); session.sendPcm(Buffer.alloc(32000)); session.stop();
  const summary = getUsageSummary('today'); assert.equal(summary.requests, 1); assert.equal(summary.audioSeconds, 1);
});
test('file task freezes hotword submission evidence, preserves paid checkpoint despite dictionary edits, and deduplicates usage', async t => {
  const dir = fixture(t); await saveHotwords('Earshot'); const filePath = join(dir, 'audio.wav'), checkpointPath = join(dir, 'task.json'); wav(filePath);
  let submits = 0, throwOnce = true;
  const fake = async (url, init) => {
    if (url.includes('getPolicy')) return Response.json({ data: { upload_host: 'https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload', upload_dir: 'test' } });
    if (url.endsWith('/upload')) return new Response('');
    if (url.endsWith('/transcription')) { submits++; assert.equal(JSON.parse(init.body).parameters.vocabulary_id, 'vocab-earshot-1'); return Response.json({ output: { task_id: 'task-id' } }); }
    if (url.includes('/tasks/')) { if (throwOnce) return new Response('', { status: 401 }); return Response.json({ usage: { duration: 2 }, output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json' }] } }); }
    return Response.json({ sentences: [{ begin_time: 0, end_time: 500, text: 'Earshot' }] });
  };
  const options = { apiKey: 'fixture-key', filePath, checkpointPath, diarize: false, fetchImpl: fake, sleep: async () => {} };
  await assert.rejects(transcribeFile(options), /401/);
  const submitted = JSON.parse(readFileSync(checkpointPath, 'utf8')); assert.match(submitted.hotwordRevision, /^[a-f0-9]{64}$/); assert.equal(submitted.vocabularyId, 'vocab-earshot-1');
  await saveHotwords('MatrixOne'); throwOnce = false; await transcribeFile(options); await transcribeFile(options);
  assert.equal(submits, 1); const resumed = JSON.parse(readFileSync(checkpointPath, 'utf8')); assert.equal(resumed.hotwordRevision, submitted.hotwordRevision);
  const summary = getUsageSummary(); assert.equal(summary.requests, 1); assert.equal(summary.audioSeconds, 2); assert.equal(summary.unconfirmedRequests, 0);
});
test('editing hotwords never resubmits an uncertain paid file request automatically', async t => {
  const dir = fixture(t); await saveHotwords('Old'); const filePath = join(dir, 'audio.wav'), checkpointPath = join(dir, 'task.json'); wav(filePath); let submits = 0;
  const fake = async url => {
    if (url.includes('getPolicy')) return Response.json({ data: { upload_host: 'https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload', upload_dir: 'test' } });
    if (url.endsWith('/upload')) return new Response('');
    submits++; throw new Error('uncertain network');
  };
  const opts = { apiKey: 'fixture-key', filePath, checkpointPath, diarize: false, fetchImpl: fake, sleep: async () => {} };
  await assert.rejects(transcribeFile(opts), /提交结果未知/); await saveHotwords('New');
  await assert.rejects(transcribeFile(opts), /提交结果未知/); assert.equal(submits, 1);
  const summary = getUsageSummary(); assert.equal(summary.requests, 1); assert.equal(summary.unconfirmedRequests, 1);
});

test('real file submission keeps the request account vocabulary while key and words change during upload', async t => {
  const dir = fixture(t);
  let currentKey = 'account-a', count = 0;
  const models = new Map();
  configureHotwords(join(dir, 'account-hotwords.json'), () => currentKey, async (_url, init) => {
    const input = JSON.parse(init.body).input;
    if (input.action === 'create_vocabulary') { const id = `vocab-account-${++count}`; models.set(id, input.target_model); return Response.json({ output: { vocabulary_id: id } }); }
    if (input.action === 'query_vocabulary') return Response.json({ output: { status: 'OK', target_model: models.get(input.vocabulary_id) } });
    return Response.json({ output: {} });
  });
  await saveHotwords('Original');
  const filePath = join(dir, 'account.wav'), checkpointPath = join(dir, 'account-task.json'); wav(filePath);
  let uploaded, releaseUpload;
  const uploading = new Promise(resolve => uploaded = resolve), pause = new Promise(resolve => releaseUpload = resolve);
  let submitted;
  const request = transcribeFile({ apiKey: 'account-a', filePath, checkpointPath, diarize: false, sleep: async () => {}, fetchImpl: async (url, init) => {
    if (url.includes('getPolicy')) return Response.json({ data: { upload_host: 'https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload', upload_dir: 'test' } });
    if (url.endsWith('/upload')) { uploaded(); await pause; return new Response(''); }
    if (url.endsWith('/transcription')) { submitted = { authorization: init.headers.Authorization, body: JSON.parse(init.body) }; return Response.json({ output: { task_id: 'account-task' } }); }
    if (url.includes('/tasks/')) return Response.json({ usage: { duration: 1 }, output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json' }] } });
    return Response.json({ sentences: [{ begin_time: 0, end_time: 500, text: 'Original' }] });
  } });
  await uploading;
  currentKey = 'account-b'; await saveHotwords('Replacement');
  releaseUpload(); await request;
  assert.equal(submitted.authorization, 'Bearer account-a');
  assert.equal(submitted.body.parameters.vocabulary_id, 'vocab-account-1');
  assert.equal(JSON.parse(readFileSync(checkpointPath, 'utf8')).vocabularyId, 'vocab-account-1');
});

test('same-account hotword edit preserves cloud contents used by an uploading file task', async t => {
  const dir = fixture(t), cloud = new Map(); let count = 0;
  configureHotwords(join(dir, 'immutable-hotwords.json'), () => 'same-account', async (_url, init) => {
    const input = JSON.parse(init.body).input;
    if (input.action === 'create_vocabulary') {
      const id = `vocab-version-${++count}`;
      cloud.set(id, { model: input.target_model, words: input.vocabulary });
      return Response.json({ output: { vocabulary_id: id } });
    }
    if (input.action === 'update_vocabulary') cloud.get(input.vocabulary_id).words = input.vocabulary;
    if (input.action === 'delete_vocabulary') cloud.delete(input.vocabulary_id);
    return Response.json({ output: input.action === 'query_vocabulary' ? { status: 'OK', target_model: cloud.get(input.vocabulary_id).model } : {} });
  });
  await saveHotwords('Original');
  const filePath = join(dir, 'immutable.wav'), checkpointPath = join(dir, 'immutable-task.json'); wav(filePath);
  let started, resume, observed;
  const uploading = new Promise(resolve => started = resolve), pause = new Promise(resolve => resume = resolve);
  const request = transcribeFile({ apiKey: 'same-account', filePath, checkpointPath, diarize: false, sleep: async () => {}, fetchImpl: async (url, init) => {
    if (url.includes('getPolicy')) return Response.json({ data: { upload_host: 'https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload', upload_dir: 'test' } });
    if (url.endsWith('/upload')) { started(); await pause; return new Response(''); }
    if (url.endsWith('/transcription')) {
      const id = JSON.parse(init.body).parameters.vocabulary_id;
      observed = { id, words: cloud.get(id)?.words };
      return Response.json({ output: { task_id: 'immutable-task' } });
    }
    if (url.includes('/tasks/')) return Response.json({ output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json' }] } });
    return Response.json({ sentences: [{ begin_time: 0, end_time: 500, text: 'Original' }] });
  } });
  await uploading;
  try { await saveHotwords('Replacement'); } finally { resume(); }
  await request;
  assert.deepEqual(observed, { id: 'vocab-version-1', words: [{ text: 'Original', weight: 4 }] });
  assert.equal(JSON.parse(readFileSync(checkpointPath, 'utf8')).vocabularyId, observed.id);
});
