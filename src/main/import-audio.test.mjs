import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, stat, truncate, mkdir } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importAudio, AUDIO_IMPORT_LIMITS } from './import-audio.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'earshot-import-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourcePath = join(root, '采访.MP3'), sessionsRoot = join(root, 'sessions');
  await writeFile(sourcePath, Buffer.from('encoded-fixture-source'));
  await mkdir(sessionsRoot);
  const original = await readFile(sourcePath), commits = [], updates = [];
  const input = { sourcePath, sessionsRoot,
    decode: async (_path, { onPCM, onProgress }) => {
      onPCM(new Uint8Array(16000)); onProgress?.(50); onPCM(new Uint8Array(16000));
      return { durationSec: 1 };
    }, commit: result => commits.push(result), onProgress: value => updates.push(value) };
  return { ...input, input, original, commits, updates };
}

test('import preserves original, commits only a complete 16k mono system track, and reports bounded progress', async t => {
  const h = await fixture(t);
  h.input.commit = result => {
    h.commits.push(result);
    assert.equal(h.updates.at(-1).phase, 'saving');
  };
  const result = await importAudio(h.input);
  assert.equal(result.title, '采访'); assert.equal(result.originalFilename, '采访.MP3'); assert.equal(result.durationSec, 1);
  assert.deepEqual(await readFile(h.sourcePath), h.original);
  const dir = join(h.sessionsRoot, result.id);
  assert.deepEqual((await readdir(dir)).sort(), ['original.mp3', 'system.wav']);
  assert.deepEqual(await readFile(join(dir, 'original.mp3')), h.original);
  const wav = await readFile(join(dir, 'system.wav'));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 32000); assert.equal(wav.length, 32044);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  for (const name of await readdir(dir)) assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600);
  assert.equal(h.commits.length, 1);
  assert.deepEqual(h.updates.at(-1), { phase: 'saving', percent: 100 });
  assert.ok(h.updates.every(row => row.percent >= 0 && row.percent <= 100));
});

for (const failure of ['decode', 'empty', 'partial', 'too-long', 'oversized-chunk', 'odd-chunk', 'commit', 'cancel-copy', 'cancel-decode']) {
  test(`failed ${failure} import removes only its own output and never changes the source`, async t => {
    const h = await fixture(t), abort = new AbortController();
    await mkdir(join(h.sessionsRoot, 'existing')); await writeFile(join(h.sessionsRoot, 'existing', 'keep'), 'untouched');
    h.input.signal = abort.signal;
    if (failure === 'cancel-copy') h.input.onProgress = ({ phase }) => { if (phase === 'copying') abort.abort(); };
    if (failure === 'commit') h.input.commit = () => { throw Error('disk full'); };
    if (!['cancel-copy', 'commit'].includes(failure)) h.input.decode = async (_path, { onPCM }) => {
      if (failure === 'decode') throw Error('corrupt audio');
      if (failure === 'cancel-decode') { abort.abort(); onPCM(new Uint8Array(32000)); }
      if (failure === 'oversized-chunk') onPCM(new Uint8Array(AUDIO_IMPORT_LIMITS.chunkBytes + 2));
      if (failure === 'odd-chunk') onPCM(new Uint8Array(1));
      if (failure === 'partial' || failure === 'too-long') onPCM(new Uint8Array(32000));
      return { durationSec: failure === 'too-long' ? 1801 : 2 };
    };
    await assert.rejects(importAudio(h.input));
    assert.deepEqual(await readdir(h.sessionsRoot), ['existing']);
    assert.deepEqual(await readFile(h.sourcePath), h.original);
    assert.equal(h.commits.length, 0);
    assert.equal(await readFile(join(h.sessionsRoot, 'existing', 'keep'), 'utf8'), 'untouched');
  });
}

test('unsupported and oversized sources are rejected before decode or session creation', async t => {
  const h = await fixture(t); let decoded = false;
  h.input.decode = async () => { decoded = true; return { durationSec: 1 }; };
  await assert.rejects(importAudio({ ...h.input, sourcePath: h.sourcePath + '.txt' }), /WAV/);
  await truncate(h.sourcePath, AUDIO_IMPORT_LIMITS.bytes + 1);
  await assert.rejects(importAudio(h.input), /64 MB/);
  assert.equal(decoded, false); assert.deepEqual(await readdir(h.sessionsRoot), []);
});

test('cancel before start never reads the source or allocates a session', async t => {
  const h = await fixture(t), abort = new AbortController(); abort.abort();
  await assert.rejects(importAudio({ ...h.input, signal: abort.signal, sourcePath: '/missing/file.wav' }), /取消/);
  assert.deepEqual(await readdir(h.sessionsRoot), []);
});

test('a closing progress consumer cannot report failure after metadata was committed', async t => {
  const h = await fixture(t);
  const result = await importAudio({ ...h.input, onProgress: () => { throw Error('UI was closed'); } });
  assert.equal(h.commits.length, 1);
  assert.ok((await stat(join(h.sessionsRoot, result.id, 'system.wav'))).size > 44);
});
