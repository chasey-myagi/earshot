// A stalled seek reports a recoverable error. After closing playback, a new timestamp request must succeed. Electron and media boundaries are controlled; this is not physical audio acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlaybackController } from './playback.ts';
import { createMediaPlayback } from '../renderer/media-playback.ts';
import { createPcmWavWriter } from './store/wav.ts';
import { createSessionStore } from './store/sessions.ts';


// The same external media event model is used by Node and Chromium.
class ControlledAudio extends EventTarget {
  static unavailable = true;
  static instances = [];
  src = ''; preload = ''; paused = true; ended = false; readyState = 0;
  duration = 30; seeking = false; time = 0;
  constructor() { super(); ControlledAudio.instances.push(this); }
  get currentTime() { return this.time; }
  set currentTime(value) {
    this.time = value; this.seeking = true;
    queueMicrotask(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); });
  }
  async play() {
    if (ControlledAudio.unavailable) throw new Error('controlled transient device failure');
    this.paused = false; this.dispatchEvent(new Event('play'));
  }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  load() {
    if (this.src) queueMicrotask(() => {
      this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata'));
    });
    else this.readyState = 0;
  }
}

function recording(t) {
  const root = mkdtempSync(join(tmpdir(), 'earshot-repro-T1-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(join(root, 'Earshot'));
  const doc = store.createRecording();
  doc.title = 'Session A'; store.writeSession(doc);
  const dir = store.sessionDir(doc.id);
  const writer = createPcmWavWriter(join(dir, 'system.wav'));
  try { writer.write(Buffer.alloc(30 * 32000, 1)); } finally { writer.close(); }
  store.finalize(doc.id, 'complete', { durationSec: 30 });
  writeFileSync(join(dir, 'live.jsonl'), [5, 12].map(second => JSON.stringify({
    id: `turn-${second}`, track: 'you', speaker: '你', tStartMs: second * 1000,
    tEndMs: (second + 3) * 1000, text: `Playback marker ${second}`,
  })).join('\n') + '\n');
  return { root, dir, id: doc.id };
}

function playbackView(state) {
  return { sessionId: state?.sessionId, status: state?.status, positionSec: state?.positionSec };
}

for (const closeFirst of [false, true]) {
  test(`connected timestamp ${closeFirst ? 'control recovers after closing failed playback' : 'recovers the same session after transient media failure'}`, async t => {
    const h = recording(t);
    ControlledAudio.unavailable = true; ControlledAudio.instances = [];
    const controller = createPlaybackController({ send: command => { void host.command(command); }, timeoutMs: 1000 });
    const host = createMediaPlayback({ createAudio: () => new ControlledAudio(), report: report => controller.report(report) });
    t.after(() => { host.dispose(); controller.hostClosed(); });
    controller.hostReady();
    const initial = await controller.play(h.dir, h.id, 'Session A', 5);
    assert.equal(initial.ok, false);
    assert.deepEqual(playbackView(controller.snapshot()), { sessionId: h.id, status: 'error', positionSec: 5 });
    ControlledAudio.unavailable = false;
    if (closeFirst) await controller.stopAndWait();
    const result = await controller.seekSession(h.dir, h.id, 'Session A', 12, true);
    const outcome = { result, playback: playbackView(controller.snapshot()) };
    t.diagnostic(JSON.stringify(outcome));
    assert.deepEqual(outcome, {
      result: { ok: true }, playback: { sessionId: h.id, status: 'playing', positionSec: 12 },
    }, 'A timestamp must recover playback at the requested 12 seconds');
    const media = ControlledAudio.instances.at(-1);
    assert.equal(media.currentTime, 12);
    assert.equal(media.paused, false);
    const response = controller.respond(new Request(media.src, { headers: { Range: 'bytes=384044-384045' } }));
    assert.equal(response.status, 206);
    assert.equal(Buffer.from(await response.arrayBuffer()).readInt16LE(0), 257);
  });
}
