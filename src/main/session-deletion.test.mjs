import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from './store/sessions.ts';
import { createSessionDeletion } from './session-deletion.ts';

function setup(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'earshot-deletion-'));
  const store = createSessionStore(root), doc = store.createRecording();
  store.finalize(doc.id, 'complete'); store.rememberPerson('王明');
  writeFileSync(join(store.sessionDir(doc.id), 'mic.wav'), 'original-audio');
  const changes = [], trashed = [];
  const deletion = createSessionDeletion({ store, active: () => false, quiesce: async () => {},
    trash: async path => { const dest = join(root, 'os-trash'); renameSync(path, dest); trashed.push(dest); },
    changed: (...args) => changes.push(args), ...extra });
  t.after(() => { deletion.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, doc, deletion, trashed, changes };
}

test('delete and undo preserve exact audio and people, invalidate list/detail caches', async t => {
  const h = setup(t);
  h.store.listSummaries(); h.store.getDetail(h.doc.id);
  assert.equal((await h.deletion.remove(h.doc.id)).ok, true);
  assert.equal(h.store.readSession(h.doc.id), null);
  assert.equal(h.store.getDetail(h.doc.id), null);
  assert.equal(h.store.listSummaries().length, 0);
  assert.deepEqual(h.store.readPeople(), ['王明']);
  assert.equal(h.deletion.undo(h.doc.id).ok, true);
  assert.equal(readFileSync(join(h.store.sessionDir(h.doc.id), 'mic.wav'), 'utf8'), 'original-audio');
  assert.equal(h.store.listSummaries()[0].id, h.doc.id);
  assert.equal(h.trashed.length, 0);
});

test('delete waits for the late writer, blocks concurrent removal, then moves its final output', async t => {
  let release, entered;
  const reached = new Promise(r => entered = r), writer = new Promise(r => release = r);
  const h = setup(t, { quiesce: async () => { entered(); await writer; writeFileSync(join(h.store.sessionDir(h.doc.id), 'late.json'), 'last write'); } });
  const pending = h.deletion.remove(h.doc.id); await reached;
  assert.equal(h.deletion.blocked(h.doc.id), true);
  assert.equal(existsSync(h.store.sessionDir(h.doc.id)), true);
  assert.equal((await h.deletion.remove(h.doc.id)).ok, false);
  release(); assert.equal((await pending).ok, true);
  assert.equal(h.deletion.undo(h.doc.id).ok, true);
  assert.equal(readFileSync(join(h.store.sessionDir(h.doc.id), 'late.json'), 'utf8'), 'last write');
});

test('active recording, invalid path and failed quiesce leave the original directory intact', async t => {
  const h = setup(t, { active: () => true });
  assert.equal((await h.deletion.remove(h.doc.id)).ok, false);
  assert.equal((await h.deletion.remove('../people.json')).ok, false);
  assert.equal(existsSync(h.store.sessionDir(h.doc.id)), true);
  const broken = createSessionDeletion({ store: h.store, active: () => false, quiesce: async () => { throw Error('busy file'); }, trash: async () => { throw Error('must not run'); }, changed() {} });
  assert.equal((await broken.remove(h.doc.id)).ok, false);
  assert.equal(existsSync(h.store.sessionDir(h.doc.id)), true); broken.close();
});

test('after the undo window only OS Trash owns the audio; undo cannot recreate empty sessions', async t => {
  const h = setup(t, { undoMs: 10 });
  await h.deletion.remove(h.doc.id);
  await new Promise(r => setTimeout(r, 35));
  assert.equal(h.trashed.length, 1); assert.equal(h.deletion.undo(h.doc.id).ok, false);
  assert.equal(existsSync(h.store.sessionDir(h.doc.id)), false);
  assert.equal(readFileSync(join(h.trashed[0], 'mic.wav'), 'utf8'), 'original-audio');
});

test('Trash failure remains recoverable beyond expiry', async t => {
  const h = setup(t, { undoMs: 10, trash: async () => { throw Error('permission denied'); } });
  await h.deletion.remove(h.doc.id); await new Promise(r => setTimeout(r, 35));
  assert.match(h.deletion.snapshot()[0].error, /仍安全保留/);
  assert.equal(h.deletion.undo(h.doc.id).ok, true);
  assert.equal(existsSync(join(h.store.sessionDir(h.doc.id), 'mic.wav')), true);
});

test('restart during undo restores the original session and never overwrites a collision', async t => {
  const h = setup(t); await h.deletion.remove(h.doc.id); h.deletion.close();
  const restarted = createSessionDeletion({ store: h.store, active: () => false, quiesce: async () => {}, trash: async () => {}, changed() {} });
  restarted.recover(); assert.equal(h.store.listSummaries()[0].id, h.doc.id);
  assert.equal(readFileSync(join(h.store.sessionDir(h.doc.id), 'mic.wav'), 'utf8'), 'original-audio');
  await restarted.remove(h.doc.id);
  h.store.writeSession({ ...h.doc, title: 'new directory owner' });
  assert.equal(restarted.undo(h.doc.id).ok, false);
  assert.equal(h.store.readSession(h.doc.id).title, 'new directory owner');
  assert.equal(readFileSync(join(h.root, 'pending-deletions', h.doc.id, 'mic.wav'), 'utf8'), 'original-audio');
  restarted.close();
});
