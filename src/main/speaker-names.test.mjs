import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSessionStore } from './store/sessions.ts';
import { createSpeakerNames } from './speaker-names.ts';
import { createPcmWavWriter } from './store/wav.ts';
import { readVoiceBook } from './voiceprint/book.ts';
import { enrollSpeaker } from './voiceprint/enroll.ts';
import { identifySession } from './voiceprint/identify.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'earshot-names-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(root), doc = store.createRecording();
  store.finalize(doc.id, 'complete');
  const turns = ['小 A', '小 B', '小 A', '小 B', '小 C', '你'].map((speaker, i) => ({
    id: 't-' + i, track: speaker === '你' ? 'you' : 'other', speaker, tStartMs: i * 1000, text: 'turn-' + i,
  }));
  writeFileSync(join(store.sessionDir(doc.id), 'live.jsonl'), turns.map(x => JSON.stringify(x)).join('\n'));
  return { store, id: doc.id };
}

test('naming changes actual roots only and undo restores prior maps without global registration', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { store, id } = fixture(t), enrolled = [];
  writeFileSync(join(store.sessionDir(id), 'names.json'), JSON.stringify({ '小 A': '老王', '小 B': '老王', '小 C': '小李' }));
  const names = createSpeakerNames({ store, enroll: async opts => enrolled.push(opts), undoMs: 8000 });
  t.after(() => names.close());
  const result = names.rename({ sessionId: id, from: '老王', to: '王明' });
  assert.equal(result.ok, true);
  assert.equal(result.changedTurns, 4);
  assert.equal(result.expiresAt, 9000);
  assert.deepEqual(store.readNames(id), { '小 A': '王明', '小 B': '王明', '小 C': '小李' });
  assert.deepEqual(store.readPeople(), [], 'person registry is deferred during undo');
  assert.equal(names.undo(result.undoId).ok, true);
  assert.deepEqual(store.readNames(id), { '小 A': '老王', '小 B': '老王', '小 C': '小李' });
  t.mock.timers.tick(9000); await Promise.resolve();
  assert.deepEqual(enrolled, []);
  assert.deepEqual(store.readPeople(), []);
  assert.deepEqual(store.getDetail(id).turns.map(x => x.speaker), ['老王','老王','老王','老王','小李','你']);
});

test('undo of an old rename cannot overwrite a later rename, even after newer undo', t => {
  const { store, id } = fixture(t), names = createSpeakerNames({ store });
  t.after(() => names.close());
  const first = names.rename({ sessionId: id, from: '小 A', to: '王明' });
  const second = names.rename({ sessionId: id, from: '王明', to: '李雷' });
  assert.equal(names.undo(first.undoId).ok, false);
  assert.deepEqual(store.readNames(id), { '小 A': '李雷' });
  assert.equal(names.undo(second.undoId).ok, true);
  assert.deepEqual(store.readNames(id), { '小 A': '王明' });
  assert.equal(names.undo(first.undoId).ok, false);
});

test('undo restores absent keys and preserves changes to unrelated clusters and other sessions', t => {
  const { store, id } = fixture(t), names = createSpeakerNames({ store });
  t.after(() => names.close());
  store.rememberPerson('已有人物');
  const op = names.rename({ sessionId: id, from: '小 A', to: '已有人物' });
  const other = names.rename({ sessionId: id, from: '小 B', to: '另一人' });
  const second = store.createRecording(); store.finalize(second.id, 'complete');
  store.writeNames(second.id, { '小 A': '别场名字' });
  assert.equal(names.undo(op.undoId).ok, true);
  assert.deepEqual(store.readNames(id), { '小 B': '另一人' });
  assert.deepEqual(store.readNames(second.id), { '小 A': '别场名字' });
  assert.deepEqual(store.readPeople(), ['已有人物']);
  assert.equal(names.undo(other.undoId).ok, true);
});

test('expiry registers each actual named cluster once and a forged or expired token is rejected', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { store, id } = fixture(t), calls = [];
  store.writeNames(id, { '小 A': '同一人', '小 B': '同一人' });
  const names = createSpeakerNames({ store, enroll: async opts => {
    assert.equal(opts.isCurrent(), true); calls.push({ from: opts.from, to: opts.to, sessionId: opts.sessionId });
  } }); t.after(() => names.close());
  const op = names.rename({ sessionId: id, from: '同一人', to: '新名' });
  t.mock.timers.tick(7999); await Promise.resolve(); assert.equal(calls.length, 0);
  t.mock.timers.tick(1); for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(calls, [{ from: '小 A', to: '新名', sessionId: id }, { from: '小 B', to: '新名', sessionId: id }]);
  assert.deepEqual(store.readPeople(), ['新名']);
  assert.equal(names.undo(op.undoId).ok, false);
  assert.equal(names.undo('../forged').ok, false);
});

for (const kind of ['refined', 'speakers', 'new-job']) {
  test(`new ${kind} invalidates old undo and deferred registration`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const { store, id } = fixture(t), calls = [];
    const names = createSpeakerNames({ store, enroll: async opts => calls.push(opts) }); t.after(() => names.close());
    const op = names.rename({ sessionId: id, from: '小 A', to: '王明' });
    if (kind === 'new-job') names.invalidate(id);
    else store.patchJobs(id, { [kind]: { status: 'done', current: kind + '-v2.json' } });
    assert.equal(names.undo(op.undoId).ok, false);
    t.mock.timers.tick(9000); await Promise.resolve();
    assert.deepEqual(calls, []);
    assert.equal(store.readNames(id)['小 A'], '王明');
  });
}

test('late embedding guard turns false after a later rename and after close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { store, id } = fixture(t), requests = [];
  const names = createSpeakerNames({ store, enroll: opts => new Promise(resolve => requests.push({ opts, resolve })) });
  const op = names.rename({ sessionId: id, from: '小 A', to: '王明' });
  t.mock.timers.tick(8000); assert.equal(requests.length, 1); assert.equal(requests[0].opts.isCurrent(), true);
  names.rename({ sessionId: id, from: '王明', to: '李雷' });
  assert.equal(requests[0].opts.isCurrent(), false);
  assert.equal(names.undo(op.undoId).ok, false);
  requests[0].resolve(); await Promise.resolve();
  names.close();
  assert.deepEqual(store.readPeople(), ['王明', '李雷']);
  assert.deepEqual(createSessionStore(store.rootDir).readNames(id), { '小 A': '李雷' });
});

test('invalid input and recording cannot change names; no-op returns no undo', t => {
  const { store, id } = fixture(t), names = createSpeakerNames({ store }); t.after(() => names.close());
  for (const input of [
    { sessionId: '../outside', from: '小 A', to: '名字' },
    { sessionId: id, from: '小 A', to: ' ' }, { sessionId: id, from: '小 A', to: '你' },
    { sessionId: id, from: '小 A', to: '名'.repeat(81) }, { sessionId: id, from: '不存在', to: '新名' },
  ]) assert.equal(names.rename(input).ok, false);
  assert.deepEqual(names.rename({ sessionId: id, from: '小 A', to: '小 A' }), { ok: true });
  assert.deepEqual(store.readNames(id), {});
  const recording = store.createRecording();
  assert.equal(names.rename({ sessionId: recording.id, from: '对方', to: '王明' }).ok, false);
});

// Undoing a second rename must preserve the first name in this session and in future speaker matching.


const embedSameSpeaker = async () => new Float32Array([1, 0, 0]);
const settleAsyncWork = () => new Promise(resolve => setImmediate(resolve));

function completedSession(store) {
  const doc = store.createRecording();
  store.finalize(doc.id, 'complete');
  store.patchJobs(doc.id, { speakers: { status: 'done', current: 'speakers-v1.json' } });
  const dir = store.sessionDir(doc.id);
  const writer = createPcmWavWriter(join(dir, 'system.wav'));
  const pcm = Buffer.alloc(8 * 16000 * 2);
  for (let i = 0; i < 8 * 16000; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / 16000) * 8000), i * 2);
  }
  writer.write(pcm);
  writer.close();
  writeFileSync(join(dir, 'live.jsonl'), `${JSON.stringify({
    id: 'speech-1', track: 'other', speaker: '小 A', tStartMs: 0, text: '本场发言',
  })}\n`);
  writeFileSync(join(dir, 'speakers-v1.json'), JSON.stringify({
    clusters: [{ speaker: '小 A', segments: [{ startMs: 0, endMs: 8000 }] }],
  }));
  return doc.id;
}

function registrationFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const root = mkdtempSync(join(tmpdir(), 'earshot-repro-c1-'));
  const store = createSessionStore(root);
  const sessionId = completedSession(store);
  const names = createSpeakerNames({
    store,
    // Delegate to the production enrollment function, injecting only the
    // model/utility-process boundary that enrollSpeaker already exposes.
    enroll: input => enrollSpeaker({ ...input, embed: embedSameSpeaker }),
  });
  t.after(() => { names.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, sessionId, names };
}

async function observeCrossSessionReuse(t, { root, store, sessionId, names }) {
  // More than the complete 8-second undo period since the last user action.
  t.mock.timers.tick(9000);
  await settleAsyncWork();
  const afterExpiry = {
    people: store.readPeople(),
    voiceNames: readVoiceBook(root).map(person => person.name),
  };
  names.close();
  const reopened = createSessionStore(root);
  const afterReopen = {
    speaker: reopened.getDetail(sessionId).turns[0].speaker,
    people: reopened.readPeople(),
    voiceNames: readVoiceBook(root).map(person => person.name),
  };
  const nextId = completedSession(reopened);
  const candidateNames = reopened.getDetail(nextId).people;
  await identifySession({ store: reopened, sessionId: nextId, embed: embedSameSpeaker });
  return {
    afterExpiry,
    afterReopen,
    nextSession: { candidateNames, matchedSpeaker: reopened.getDetail(nextId).turns[0].speaker },
  };
}

const reusableWang = {
  afterExpiry: { people: ['王明'], voiceNames: ['王明'] },
  afterReopen: { speaker: '王明', people: ['王明'], voiceNames: ['王明'] },
  nextSession: { candidateNames: ['王明'], matchedSpeaker: '王明' },
};

test('C1: undoing a second pending rename preserves the restored name for future sessions after expiry and reopening', async t => {
  const context = registrationFixture(t);
  const { store, sessionId, names } = context;
  const first = names.rename({ sessionId, from: '小 A', to: '王明' });
  assert.equal(first.ok, true);
  t.mock.timers.tick(1000);
  const second = names.rename({ sessionId, from: '王明', to: '李雷' });
  assert.equal(second.ok, true);
  assert.equal(names.undo(second.undoId).ok, true);
  assert.equal(store.getDetail(sessionId).turns[0].speaker, '王明');
  assert.equal(names.undo(first.undoId).ok, false, 'restoring the name must not revive an obsolete undo token');
  assert.equal(names.undo(second.undoId).ok, false, 'the applied undo cannot be used again');

  assert.deepEqual(await observeCrossSessionReuse(t, context), reusableWang,
    'the restored valid name must enter durable registries and be selectable and recognizable in the next session');
});

test('C1 control: a single pending rename remains selectable and recognizable after expiry and reopening', async t => {
  const context = registrationFixture(t);
  const { sessionId, names } = context;
  const first = names.rename({ sessionId, from: '小 A', to: '王明' });
  assert.equal(first.ok, true);
  assert.deepEqual(await observeCrossSessionReuse(t, context), reusableWang);
  assert.equal(names.undo(first.undoId).ok, false, 'an expired undo token stays invalid');
});
