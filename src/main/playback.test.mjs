import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPcmWavWriter } from './store/wav.ts';
import { createPlaybackController } from './playback.ts';

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'earshot-player-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['mic.wav', 'system.wav']) {
    const wav = createPcmWavWriter(join(dir, name));
    wav.write(Buffer.alloc(30 * 32000, 1)); wav.close();
  }
  const commands = [], changes = [];
  const controller = createPlaybackController({ send: c => commands.push(c),
    onChange: () => changes.push(controller.snapshot()), timeoutMs: 30, ...options });
  controller.hostReady();
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  function report(status, positionSec, command = commands.at(-1), ack = true) {
    controller.report({ token: command.token, commandId: command.id, status, positionSec, ack });
  }
  async function play(id = 'session-a', positionSec = 0) {
    const pending = controller.play(dir, id, `Title ${id}`, positionSec);
    await flush(); report('playing', positionSec); assert.equal((await pending).ok, true);
    return commands.at(-1);
  }
  return { controller, commands, changes, report, flush, play, dir };
}

test('one media clock drives pause, resume, seek and natural end without touching selected session', async t => {
  const h = fixture(t); await h.play();
  h.report('playing', 8.4, undefined, false);
  assert.equal(h.controller.snapshot().positionSec, 8.4);
  const pause = h.controller.pause(); await h.flush();
  assert.equal(h.commands.at(-1).action, 'pause');
  h.report('paused', 8.7); assert.equal((await pause).ok, true);
  assert.equal(h.controller.snapshot().status, 'paused');
  assert.equal(h.controller.snapshot().positionSec, 8.7);
  const seek = h.controller.seekSession(h.dir, h.controller.snapshot()?.sessionId, 'Title', 20); await h.flush();
  assert.equal(h.commands.at(-1).positionSec, 20);
  h.report('paused', 20); await seek;
  const resume = h.controller.resume(); await h.flush(); h.report('playing', 20); await resume;
  h.report('ended', 30, undefined, false);
  assert.equal(h.controller.snapshot().status, 'ended');
  assert.equal(h.controller.snapshot().sessionId, 'session-a');
  const afterEnd = h.controller.pause(); await h.flush(); h.report('ended', 30);
  assert.equal((await afterEnd).ok, true, 'a pause racing natural end is already satisfied');
});

test('switching sessions and stop revoke prior capability and ignore old media callbacks', async t => {
  const h = fixture(t); const first = await h.play('session-a', 10);
  assert.equal(h.controller.respond(new Request(first.url)).status, 200);
  const next = h.controller.play(h.dir, 'session-b', 'Title B', 5); await h.flush();
  const second = h.commands.at(-1);
  assert.notEqual(second.token, first.token);
  assert.equal(h.controller.respond(new Request(first.url)).status, 404);
  h.report('ended', 30, first, false);
  assert.equal(h.controller.snapshot().sessionId, 'session-b');
  assert.equal(h.controller.snapshot().status, 'loading');
  h.report('playing', 5, second); await next;
  let stopped = false;
  const stop = h.controller.stopAndWait().then(() => { stopped = true; }); await h.flush();
  assert.equal(h.controller.respond(new Request(second.url)).status, 404);
  assert.equal(stopped, false, 'capture must wait for media detach acknowledgement');
  h.report('idle', 0); await stop;
  assert.equal(h.controller.snapshot(), null);
  h.report('playing', 9, second, false);
  assert.equal(h.controller.snapshot(), null);
});

test('a stop timeout blocks capture and an acknowledged retry recovers; host destruction also ends audio', async t => {
  const h = fixture(t); await h.play();
  await assert.rejects(h.controller.stopAndWait(), /停止/);
  assert.equal(h.controller.snapshot().status, 'error');
  const again = h.controller.stopAndWait(); await h.flush(); h.report('idle', 0); await again;
  assert.equal(h.controller.snapshot(), null);
  const command = await h.play();
  h.controller.hostClosed();
  assert.equal(h.controller.respond(new Request(command.url)).status, 404);
  await h.controller.stopAndWait();
  assert.equal((await h.controller.play(h.dir, 'b', 'B')).ok, false);
  h.controller.hostReady(); await h.play('c');
});

test('invalid media reports and offsets cannot corrupt position or acknowledge a pending command', async t => {
  const h = fixture(t); await h.play();
  assert.equal((await h.controller.seekSession(h.dir, h.controller.snapshot()?.sessionId, 'Title', NaN)).ok, false);
  assert.equal((await h.controller.seekSession(h.dir, h.controller.snapshot()?.sessionId, 'Title', -1)).ok, false);
  assert.equal((await h.controller.seekSession(h.dir, h.controller.snapshot()?.sessionId, 'Title', 31)).ok, false);
  assert.equal(h.controller.snapshot().status, 'playing', 'invalid input must preserve the ongoing playback');
  const old = h.commands.at(-1);
  h.controller.report({ token: old.token, commandId: old.id, status: 'playing', positionSec: Infinity });
  h.controller.report({ token: 'foreign', commandId: old.id, status: 'ended', positionSec: 30 });
  assert.equal(h.controller.snapshot().positionSec, 0);
  const pause = h.controller.pause(); await h.flush();
  h.report('playing', 12, old, false);
  assert.equal(h.controller.snapshot().positionSec, 0);
  h.report('paused', 0); assert.equal((await pause).ok, true);
});

test('queued media commands wait for matching acknowledgements and restart naturally ended audio from zero', async t => {
  const h = fixture(t, { timeoutMs: 1000 });
  const loading = h.controller.play(h.dir, 'a', 'A'); await h.flush();
  const first = h.commands[0];
  const pause = h.controller.pause(), seek = h.controller.seekSession(h.dir, h.controller.snapshot()?.sessionId, 'Title', 12), next = h.controller.play(h.dir, 'b', 'B');
  await h.flush(); assert.equal(h.commands.length, 1);
  h.report('playing', 0, first, false); await h.flush(); assert.equal(h.commands.length, 1);
  h.report('paused', 0, first, true); await h.flush(); assert.equal(h.commands.length, 1);
  h.report('playing', 0, { ...first, id: first.id - 1 }, true); await h.flush(); assert.equal(h.commands.length, 1);
  h.report('playing', 0, first); assert.equal((await loading).ok, true); await h.flush();
  assert.equal(h.commands[1].action, 'pause'); h.report('paused', 1); assert.equal((await pause).ok, true); await h.flush();
  assert.equal(h.commands[2].action, 'seek'); assert.equal(h.commands[2].positionSec, 12);
  h.report('paused', 12); assert.equal((await seek).ok, true); await h.flush();
  assert.equal(h.commands[3].action, 'load'); h.report('playing', 0); assert.equal((await next).ok, true);
  h.report('ended', 30, undefined, false);
  const restart = h.controller.resume(); await h.flush();
  assert.equal(h.commands.at(-1).action, 'seek'); assert.equal(h.commands.at(-1).positionSec, 0); assert.equal(h.commands.at(-1).resume, true);
  h.report('playing', 0); assert.equal((await restart).ok, true);
  assert.equal(h.controller.snapshot().sessionId, 'b');
  const stop = h.controller.stopAndWait(); await h.flush(); h.report('idle', 0); await stop;
});

for (const revoke of ['switch', 'stop', 'close']) test(`active response terminates when playback ${revoke} revokes its capability`, async t => {
  const h = fixture(t, { timeoutMs: 1000 }); const first = await h.play();
  const reader = h.controller.respond(new Request(first.url)).body.getReader();
  assert.equal((await reader.read()).done, false);
  let action;
  if (revoke === 'switch') action = h.controller.play(h.dir, 'b', 'B');
  if (revoke === 'stop') action = h.controller.stopAndWait();
  if (revoke === 'close') h.controller.hostClosed();
  await h.flush();
  await assert.rejects(reader.read(), /音频请求已结束/);
  assert.equal(h.controller.respond(new Request(first.url)).status, 404);
  if (action) { h.report(revoke === 'stop' ? 'idle' : 'playing', 0); await action; }
  if (revoke === 'switch') assert.equal(h.controller.respond(new Request(h.commands.at(-1).url, { method: 'HEAD' })).status, 200);
});

test('valid capability cannot authorize alternate hosts, paths, credentials or non-read methods', async t => {
  const h = fixture(t); const command = await h.play();
  for (const url of [command.url + '?x=1', command.url + '#x', command.url + '/mic.wav', command.url.replace('session/', 'other/')]) {
    assert.equal(h.controller.respond(new Request(url)).status, 404, url);
  }
  assert.equal(h.controller.respond({ url: command.url.replace('://', '://user:pass@') }).status, 404);
  assert.equal(h.controller.respond(new Request(command.url, { method: 'POST' })).status, 405);
  assert.equal(h.controller.respond(new Request(command.url, { method: 'HEAD' })).body, null);
  h.controller.hostClosed();
});
