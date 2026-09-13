import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '../store/sessions.ts';
import { createSessionTitles } from './session-title.ts';
import { createSessionDeletion } from '../session-deletion.ts';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture(t, generate = async () => '产品发布安排') {
  const root = mkdtempSync(join(tmpdir(), 'earshot-auto-title-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(root);
  store.setAutoTitle(true);
  const calls = [], state = { quitting: false, blocked: new Set(), changes: 0 };
  const titles = createSessionTitles({ store, apiKey: () => 'fixture-only', quitting: () => state.quitting,
    blocked: id => state.blocked.has(id), changed: () => { state.changes++; },
    generate: async input => { calls.push(input); return generate(input); },
  });
  function recording({ duration = 60, text = '会'.repeat(200), status = 'complete', job = 'done' } = {}) {
    const doc = store.createRecording();
    if (status !== 'recording') store.finalize(doc.id, status, { durationSec: duration });
    const artifact = 'refined-v1.json';
    writeFileSync(join(store.sessionDir(doc.id), artifact), JSON.stringify({ turns: [{ id: 'one', track: 'you', speaker: '你', tStartMs: 0, text }] }));
    store.patchJobs(doc.id, { refined: { status: job, current: artifact } });
    return store.readSession(doc.id);
  }
  return { root, store, state, calls, titles, recording };
}

test('eligible recording persists one attempt before HTTP, then updates cached summaries and details', async t => {
  const result = deferred(), h = fixture(t, () => result.promise), doc = h.recording();
  h.store.listSummaries(); h.store.getDetail(doc.id);
  const pending = h.titles.start(doc.id);
  assert.equal(h.titles.start(doc.id), pending);
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  const persisted = JSON.parse(readFileSync(join(h.store.sessionDir(doc.id), 'session.json'), 'utf8'));
  assert.equal(persisted.autoTitle.state, 'attempted');
  assert.equal(persisted.autoTitle.requestId, h.calls[0].requestId);
  result.resolve('产品发布安排'); await pending;
  for (const row of [h.store.readSession(doc.id), h.store.listSummaries()[0], h.store.getDetail(doc.id)]) {
    assert.equal(row.title, '产品发布安排'); assert.equal(row.titleSource, 'auto'); assert.equal(row.titleRevision, 1);
  }
  await h.titles.start(doc.id); assert.equal(h.calls.length, 1);
  assert.equal(h.state.changes, 1);
});

for (const scenario of [
  { name: 'short audio', duration: 59, text: '会'.repeat(500) },
  { name: 'short text', text: '会'.repeat(199) },
  { name: 'punctuation and spaces', text: '，。! \n'.repeat(300) },
  { name: 'failed refined with a saved partial artifact', job: 'failed' },
  { name: 'active capture', status: 'recording' },
]) test(`does not submit ${scenario.name}`, async t => {
  const h = fixture(t), doc = h.recording(scenario);
  await h.titles.start(doc.id);
  assert.equal(h.calls.length, 0); assert.equal(h.store.readSession(doc.id).title, doc.title);
});

test('Unicode letters and numbers count, and ended crash recovery with complete refined text is eligible', async t => {
  const h = fixture(t), doc = h.recording({ text: '𠮷'.repeat(100) + '1'.repeat(100), status: 'incomplete' });
  await h.titles.start(doc.id); assert.equal(h.calls.length, 1);
});

test('older/imported sessions and dictation never gain eligibility from title shape', async t => {
  const h = fixture(t);
  for (const kind of ['legacy', 'imported', 'dictation', 'disabled']) {
    const doc = h.recording();
    if (kind === 'legacy' || kind === 'imported') { delete doc.titleSource; delete doc.titleRevision; delete doc.autoTitle; }
    if (kind === 'disabled') delete doc.autoTitle;
    if (kind === 'dictation') { doc.kind = 'dictation'; doc.dictation = { text: '会'.repeat(200), rawText: '会'.repeat(200), asrModel: 'fixture' }; }
    h.store.writeSession(doc);
    await h.titles.start(doc.id);
    assert.equal(h.store.readSession(doc.id).title, doc.title);
  }
  assert.equal(h.calls.length, 0);
});

for (const change of ['manual ABA', 'new artifact', 'failed refined', 'deletion', 'quit']) test(`late result cannot overwrite after ${change}`, async t => {
  const result = deferred(), h = fixture(t, () => result.promise), doc = h.recording();
  const pending = h.titles.start(doc.id); await Promise.resolve();
  if (change === 'manual ABA') {
    h.store.renameSession({ sessionId: doc.id, title: '手动标题' });
    h.store.renameSession({ sessionId: doc.id, title: doc.title });
  } else if (change === 'new artifact') h.store.patchJobs(doc.id, { refined: { current: 'refined-v2.json' } });
  else if (change === 'failed refined') h.store.patchJobs(doc.id, { refined: { status: 'failed' } });
  else if (change === 'deletion') h.state.blocked.add(doc.id);
  else h.state.quitting = true;
  result.resolve('迟到的自动标题'); await pending;
  assert.equal(h.store.readSession(doc.id).title, doc.title);
  assert.equal(h.state.changes, 0);
  if (change === 'manual ABA') { assert.equal(h.store.readSession(doc.id).titleSource, 'manual'); assert.equal(h.store.readSession(doc.id).titleRevision, 2); }
});

test('turning off aborts active work, skips pending work and does not enroll either on re-enable', async t => {
  const result = deferred(), h = fixture(t, () => result.promise);
  const active = h.recording(), waiting = h.recording();
  const pending = h.titles.start(active.id); await Promise.resolve();
  const disabling = h.titles.setEnabled(false);
  assert.equal(h.store.readPrefs().autoTitle, false);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.store.readSession(waiting.id).autoTitle.state, 'skipped');
  result.resolve('迟到标题'); await pending; assert.deepEqual(await disabling, { ok: true });
  assert.deepEqual(await h.titles.setEnabled(true), { ok: true });
  await h.titles.start(active.id); await h.titles.start(waiting.id);
  assert.equal(h.calls.length, 1); assert.equal(h.store.readSession(active.id).title, active.title);
  assert.equal(h.recording().autoTitle.state, 'pending');
});

test('a disable that cannot update one session stays off, and re-enable cannot resurrect its pending request', async t => {
  const h = fixture(t), doc = h.recording(), dir = h.store.sessionDir(doc.id);
  chmodSync(dir, 0o500);
  try {
    assert.equal((await h.titles.setEnabled(false)).ok, false);
    assert.equal(h.store.readPrefs().autoTitle, false);
    assert.equal((await h.titles.setEnabled(true)).ok, false);
    assert.equal(h.store.readPrefs().autoTitle, false);
  } finally { chmodSync(dir, 0o700); }
  assert.equal((await h.titles.setEnabled(true)).ok, true);
  assert.equal(h.store.readSession(doc.id).autoTitle.state, 'skipped');
  await h.titles.start(doc.id); assert.equal(h.calls.length, 0);
});

test('attempt persistence failure prevents HTTP, while provider failure and null output never retry', async t => {
  const h = fixture(t), doc = h.recording(), dir = h.store.sessionDir(doc.id);
  chmodSync(dir, 0o500);
  try { await h.titles.start(doc.id); assert.equal(h.calls.length, 0); }
  finally { chmodSync(dir, 0o700); }
  for (const generate of [async () => null, async () => { throw new Error('fixture failure'); }]) {
    const f = fixture(t, generate), row = f.recording();
    await f.titles.start(row.id); await f.titles.start(row.id);
    assert.equal(f.calls.length, 1); assert.equal(f.store.readSession(row.id).title, row.title);
    assert.equal(f.store.readSession(row.id).jobs.refined.status, 'done');
  }
});

test('restart resumes pending completed transcriptions but never resubmits a persisted attempt', async t => {
  const h = fixture(t), pending = h.recording(), attempted = h.recording();
  assert.equal(h.store.beginAutoTitle(attempted.id, 0, 'refined-v1.json', 'interrupted-request'), true);
  const store = createSessionStore(h.root), calls = [];
  const reopened = createSessionTitles({ store, apiKey: () => 'fixture-only', blocked: () => false, quitting: () => false, changed() {},
    generate: async input => { calls.push(input); return '重启后名称'; } });
  await reopened.recover();
  assert.equal(calls.length, 1); assert.equal(store.readSession(pending.id).title, '重启后名称');
  assert.equal(store.readSession(attempted.id).title, attempted.title);
});

test('deletion waits for aborted writer before moving the directory; undo keeps the original title', async t => {
  const result = deferred(), h = fixture(t, () => result.promise), doc = h.recording();
  const deletion = createSessionDeletion({ store: h.store, active: () => false,
    quiesce: id => { h.state.blocked.add(id); return h.titles.cancel(id); }, trash: async () => {}, changed() {}, undoMs: 60000 });
  t.after(() => deletion.close());
  const pending = h.titles.start(doc.id); await Promise.resolve();
  const removing = deletion.remove(doc.id);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(existsSync(h.store.sessionDir(doc.id)), true);
  result.resolve('不应该落盘'); await pending;
  assert.deepEqual(await removing, { ok: true });
  assert.equal(existsSync(h.store.sessionDir(doc.id)), false);
  assert.deepEqual(deletion.undo(doc.id), { ok: true });
  assert.equal(h.store.readSession(doc.id).title, doc.title);
});

test('parent cancellation and an aborted app quit cannot leave a permanently closed title controller', async t => {
  const result = deferred(), h = fixture(t, () => result.promise), doc = h.recording();
  const parent = new AbortController(), pending = h.titles.start(doc.id, parent.signal);
  await Promise.resolve(); parent.abort(); assert.equal(h.calls[0].signal.aborted, true);
  h.state.quitting = true;
  const closing = h.titles.cancelAll(); result.resolve('取消的标题'); await closing; await pending;
  h.state.quitting = false;
  const later = h.recording(); await h.titles.start(later.id);
  assert.equal(h.calls.length, 2); assert.equal(h.store.readSession(doc.id).title, doc.title);
  assert.equal(h.store.readSession(later.id).title, '取消的标题');
});
