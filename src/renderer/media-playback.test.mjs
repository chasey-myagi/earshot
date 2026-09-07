import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMediaPlayback } from './media-playback.ts';

class Media extends EventTarget {
  src = ''; paused = true; ended = false; readyState = 0; duration = 30;
  seeking = false; time = 0; playCalls = 0; pauseCalls = 0; loadCalls = 0;
  get currentTime() { return this.time; }
  set currentTime(value) {
    this.time = value; this.seeking = true;
    queueMicrotask(() => { this.seeking = false; this.dispatchEvent(new Event('seeked')); });
  }
  async play() { this.playCalls++; this.paused = false; this.dispatchEvent(new Event('play')); }
  pause() { this.pauseCalls++; this.paused = true; this.dispatchEvent(new Event('pause')); }
  load() {
    this.loadCalls++;
    if (this.src) queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')); });
    else this.readyState = 0;
  }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}
function fixture(options = {}) {
  const reports = [], instances = [];
  const host = createMediaPlayback({ createAudio: () => {
    const audio = options.create?.() ?? new Media(); instances.push(audio); return audio;
  }, report: value => reports.push(value), timeoutMs: 100 });
  let id = 0;
  const run = (action, extra = {}) => host.command({ action, token: 'one', id: ++id, ...extra });
  return { host, run, reports, instances };
}

test('media host uses actual currentTime, preserves pause across seeking, resumes and detaches before stop acknowledgement', async () => {
  const h = fixture(); await h.run('load', { url: 'earshot-audio://session/one', positionSec: 10 });
  const audio = h.instances[0];
  assert.equal(h.reports.at(-1).status, 'playing'); assert.equal(h.reports.at(-1).positionSec, 10);
  audio.time = 12.25; audio.dispatchEvent(new Event('timeupdate'));
  assert.equal(h.reports.at(-1).positionSec, 12.25);
  await h.run('pause'); await h.run('seek', { positionSec: 20 });
  assert.equal(audio.paused, true); assert.equal(h.reports.at(-1).status, 'paused');
  await h.run('resume'); assert.equal(audio.paused, false);
  audio.time = 30; audio.ended = true; audio.dispatchEvent(new Event('ended'));
  assert.equal(h.reports.at(-1).status, 'ended');
  await h.run('stop');
  assert.equal(audio.paused, true); assert.equal(audio.src, '');
  assert.equal(h.reports.at(-1).status, 'idle'); assert.equal(h.reports.at(-1).ack, true);
  const count = h.reports.length; audio.dispatchEvent(new Event('ended'));
  assert.equal(h.reports.length, count);
});

test('replacing a source rejects old progress and a delayed old play resolution cannot restart audio after stop', async () => {
  let resolvePlay;
  const h = fixture({ create: () => {
    const media = new Media();
    media.play = () => new Promise(resolve => { resolvePlay = () => { media.paused = false; resolve(); }; });
    return media;
  } });
  const pending = h.run('load', { url: 'earshot-audio://session/one', positionSec: 0 });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(typeof resolvePlay, 'function');
  const media = h.instances[0];
  await h.run('stop'); resolvePlay(); await pending;
  assert.equal(media.paused, true); assert.equal(media.src, '');
  assert.equal(h.reports.at(-1).status, 'idle');
});

test('new media source owns callbacks and playback errors detach its source with an actionable failure', async () => {
  const h = fixture();
  await h.run('load', { url: 'earshot-audio://session/one', positionSec: 0 });
  const old = h.instances[0];
  await h.run('load', { token: 'two', url: 'earshot-audio://session/two', positionSec: 5 });
  const current = h.instances[1];
  const count = h.reports.length;
  old.time = 28; old.dispatchEvent(new Event('timeupdate'));
  assert.equal(h.reports.length, count); assert.equal(old.src, '');
  current.dispatchEvent(new Event('error'));
  assert.equal(h.reports.at(-1).status, 'error');
  assert.equal(h.reports.at(-1).token, 'two');
  assert.equal(current.src, ''); assert.equal(current.paused, true);
});

for (const failure of ['metadata', 'seek', 'play']) test(`media ${failure} failure publishes its identity and recovers with a new source`, async () => {
  let first = true;
  const reports = [], media = [];
  const host = createMediaPlayback({ timeoutMs: 15, report: r => reports.push(r), createAudio: () => {
    const audio = new Media(); media.push(audio);
    if (first) {
      first = false;
      if (failure === 'metadata') audio.load = () => { audio.loadCalls++; };
      if (failure === 'seek') Object.defineProperty(audio, 'currentTime', { get: () => audio.time, set: v => { audio.time = v; audio.seeking = true; } });
      if (failure === 'play') audio.play = async () => { throw new Error('denied'); };
    }
    return audio;
  } });
  await host.command({ id: 10, token: 'broken', action: 'load', url: 'earshot-audio://session/broken', positionSec: 10 });
  assert.deepEqual(reports.at(-1), { token: 'broken', commandId: 10, status: 'error', positionSec: failure === 'metadata' ? 0 : 10, ack: true });
  assert.equal(media[0].src, ''); assert.equal(media[0].paused, true);
  await host.command({ id: 11, token: 'new', action: 'load', url: 'earshot-audio://session/new', positionSec: 5 });
  assert.equal(reports.at(-1).status, 'playing'); assert.equal(reports.at(-1).token, 'new');
  host.dispose();
});

for (const phase of ['metadata', 'seek']) for (const action of ['stop', 'dispose', 'replace']) test(`${action} releases a pending ${phase} wait without late success`, async () => {
  const reports = [], instances = []; let atWait;
  const entered = new Promise(resolve => { atWait = resolve; });
  const host = createMediaPlayback({ timeoutMs: 1000, report: r => {
    if (r.status === 'idle' && r.ack) {
      assert.equal(instances[0].paused, true); assert.equal(instances[0].src, '');
      assert.ok(instances[0].loadCalls >= 2, 'source release occurs before idle acknowledgement');
    }
    reports.push(r);
  }, createAudio: () => {
    const audio = new Media(); instances.push(audio);
    if (instances.length === 1) {
      if (phase === 'metadata') audio.load = () => { audio.loadCalls++; if (audio.src) atWait(); };
      else Object.defineProperty(audio, 'currentTime', { get: () => audio.time, set: v => { audio.time = v; audio.seeking = true; atWait(); } });
    }
    return audio;
  } });
  const old = host.command({ id: 1, token: 'old', action: 'load', url: 'earshot-audio://session/old', positionSec: 5 });
  await entered;
  if (action === 'dispose') host.dispose();
  else await host.command({ id: 2, token: action === 'replace' ? 'new' : 'old', action: action === 'replace' ? 'load' : 'stop', url: 'earshot-audio://session/new', positionSec: 8 });
  await old;
  const count = reports.length; instances[0].dispatchEvent(new Event('loadedmetadata')); instances[0].dispatchEvent(new Event('seeked'));
  assert.equal(reports.length, count); assert.equal(instances[0].src, ''); assert.equal(instances[0].paused, true);
  assert.equal(reports.some(r => r.token === 'old' && r.ack && r.status === 'playing'), false);
  if (action === 'replace') assert.equal(reports.at(-1).token, 'new');
  host.dispose();
});

test('production controller and media host exchange real commands and acknowledgements across pause, seek, switch, failure and stop', async t => {
  const {createPlaybackController}=await import('../main/playback.ts');
  const {createPcmWavWriter}=await import('../main/store/wav.ts');
  const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'earshot-connected-media-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const writer=createPcmWavWriter(join(dir,'system.wav'));writer.write(Buffer.alloc(32000*30));writer.close();
  const instances=[];let rejectNext=false;
  const controller=createPlaybackController({send:command=>{void host.command(command);},timeoutMs:1000});
  const host=createMediaPlayback({createAudio:()=>{const media=new Media();instances.push(media);if(rejectNext)media.play=async()=>{throw Error('device unavailable');};return media;},report:report=>controller.report(report)});
  t.after(()=>{host.dispose();controller.hostClosed();});controller.hostReady();
  assert.equal((await controller.play(dir,'a','A',10)).ok,true);assert.equal(controller.snapshot().positionSec,10);
  instances[0].time=11.25;instances[0].dispatchEvent(new Event('timeupdate'));assert.equal(controller.snapshot().positionSec,11.25);
  assert.equal((await controller.pause()).ok,true);assert.equal(controller.snapshot().status,'paused');
  assert.equal((await controller.seekSession(dir,'a','A',20)).ok,true);assert.equal(controller.snapshot().positionSec,20);assert.equal(controller.snapshot().status,'paused');
  assert.equal((await controller.seekSession(dir,'b','B',5,true)).ok,true);assert.equal(controller.snapshot().sessionId,'b');assert.equal(instances[0].src,'');
  rejectNext=true;assert.equal((await controller.play(dir,'c','C')).ok,false);assert.equal(controller.snapshot().status,'error');
  assert.equal(instances.at(-1).src,'');rejectNext=false;
  assert.equal((await controller.play(dir,'a','A')).ok,true);await controller.stopAndWait();assert.equal(controller.snapshot(),null);assert.equal(instances.at(-1).src,'');
});
