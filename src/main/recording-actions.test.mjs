import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecordingActions } from "./recording-actions.ts";

test("failed finalization retains ownership so stopping can retry without starting another recording", async () => {
  let calls = 0;
  const actions = createRecordingActions({
    start: async () => ({ ok: true }), onChange() {},
    finish: async () => { if (++calls === 1) throw new Error("disk full"); },
  });
  await actions.start();
  assert.equal((await actions.stop("stop")).ok, false);
  assert.equal(actions.phase(), "finalize_failed");
  assert.equal((await actions.start()).ok, false);
  assert.deepEqual(await actions.stop("stop"), { ok: true });
  assert.equal(actions.phase(), "idle");
  assert.equal(calls, 2);
});

test("double start shares one recording and stop waits for pending capture startup", async () => {
  let finishStartup;
  let audioOpen = false;
  let recordingCount = 0;
  const actions = createRecordingActions({
    start: async () => {
      recordingCount += 1;
      await new Promise(resolve => { finishStartup = resolve; });
      audioOpen = true;
      return { ok: true };
    },
    finish: async () => { audioOpen = false; }, onChange() {},
  });
  const first = actions.start();
  const second = actions.start();
  assert.equal(actions.phase(), "starting");
  const stopping = actions.stop("stop");
  finishStartup();
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.deepEqual(await stopping, { ok: true });
  assert.equal(recordingCount, 1);
  assert.equal(audioOpen, false);
  assert.equal(actions.phase(), "idle");
});

test("a failed startup can retry and new starts are rejected while stopping", async () => {
  let permit = false;
  let finishStop;
  const actions = createRecordingActions({
    start: async () => permit ? { ok: true } : { ok: false, error: "permission denied" },
    finish: () => new Promise(resolve => { finishStop = resolve; }), onChange() {},
  });
  assert.equal((await actions.start()).ok, false);
  assert.equal(actions.phase(), "idle");
  permit = true;
  assert.equal((await actions.start()).ok, true);
  const stopping = actions.stop("quit");
  assert.equal(actions.phase(), "stopping");
  assert.equal((await actions.start()).ok, false);
  const duplicateStop = actions.stop("stop");
  finishStop();
  assert.equal((await stopping).ok, true);
  assert.equal((await duplicateStop).ok, true);
  assert.equal(actions.phase(), "idle");
});

test("rejected startup is reported, not finalized, and a retry publishes every lifecycle phase", async () => {
  let failed = true, failStart;
  const states = [], reasons = [];
  const actions = createRecordingActions({
    start: async () => {
      if (failed) await new Promise((_resolve, reject) => { failStart = reject; });
      return { ok: true };
    },
    finish: async reason => { reasons.push(reason); },
    onChange: () => states.push(actions.phase()),
  });
  const starting = actions.start();
  const quitting = actions.stop("quit");
  failStart(new Error("capture setup failed"));
  assert.equal((await starting).ok, false);
  assert.equal((await quitting).ok, false);
  assert.deepEqual(reasons, []);
  assert.deepEqual(states, ["starting", "idle"]);
  failed = false;
  const retry = actions.start();
  const stop = actions.stop("quit");
  assert.equal((await retry).ok, true);
  assert.equal((await stop).ok, true);
  assert.deepEqual(reasons, ["quit"]);
  assert.deepEqual(states, ["starting", "idle", "starting", "recording", "stopping", "idle"]);
});
