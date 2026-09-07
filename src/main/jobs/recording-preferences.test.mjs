import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '../store/sessions.ts';
import { createPcmWavWriter } from '../store/wav.ts';
import { processSession } from './post.ts';

for (const initial of [true, false]) test(`recording retains auto diarize=${initial} through preference changes and reopening`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'earshot-prefs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let store = createSessionStore(root);
  store.setAutoDiarize(initial);
  const doc = store.createRecording();
  store.setAutoDiarize(!initial);
  store.finalize(doc.id, 'complete');
  const wav = createPcmWavWriter(join(store.sessionDir(doc.id), 'system.wav'));
  wav.write(Buffer.alloc(32000)); wav.close();
  store = createSessionStore(root);
  const flags = [];
  await processSession({ store, sessionId: doc.id, apiKey: 'fixture-only', mode: 'all',
    transcribe: async ({diarize}) => { flags.push(diarize); return [{tStartMs:0,text:'word',speakerId:0}]; },
    identify: async () => {},
  });
  assert.deepEqual(flags, [initial]);
  assert.equal(store.readSession(doc.id).autoDiarize, initial);
  assert.equal(store.createRecording().autoDiarize, !initial);
  flags.length = 0;
  await processSession({ store, sessionId: doc.id, apiKey: 'fixture-only', mode: 'speakers',
    transcribe: async ({diarize}) => { flags.push(diarize); return []; }, identify: async () => {},
  });
  assert.deepEqual(flags, [true], 'explicit speaker retry still requests diarization');
});

test('legacy recordings without a frozen preference retain the previous preference fallback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'earshot-legacy-prefs-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const store = createSessionStore(root), doc = store.createRecording();
  delete doc.autoDiarize; doc.status = 'complete';
  writeFileSync(join(store.sessionDir(doc.id), 'session.json'), JSON.stringify(doc));
  store.setAutoDiarize(false);
  const wav = createPcmWavWriter(join(store.sessionDir(doc.id), 'system.wav'));
  wav.write(Buffer.alloc(32000)); wav.close();
  await processSession({ store, sessionId:doc.id, apiKey:'fixture-only', mode:'all',
    transcribe:async ({diarize}) => { assert.equal(diarize, false); return []; }, identify:async () => {},
  });
  assert.equal(store.readSession(doc.id).autoDiarize, undefined);
});
