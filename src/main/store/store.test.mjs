import assert from "node:assert/strict";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { assembleSnapshot } from "./snapshot.ts";
import { createSessionStore } from "./sessions.ts";
import { createLiveBuffer, persistLive } from "../live.ts";

let root;

function tmpRoot() {
  root = mkdtempSync(join(tmpdir(), "earshot-store-"));
  return root;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function snapshotRuntime(selectedId) {
  return {
    hasApiKey: true,
    permissions: { microphone: "granted", screen: "granted" },
    recording: { sessionId: selectedId, startedAt: "2026-08-19T00:00:00.000Z", glanceVisible: true },
    playingSessionId: null,
    selectedId,
    now: Date.parse("2026-08-19T00:10:00.000Z"),
  };
}

test("stopping keeps dual-track transcript order even when confirmations arrived out of order", () => {
  const store = createSessionStore(tmpRoot());
  const session = store.createRecording();
  const buffer = createLiveBuffer();
  for (const [track, id, time] of [["other", "a", 5000], ["you", "b", 1000]]) {
    persistLive(store.sessionDir(session.id), buffer.apply(track,
      { sentenceId: id, tStartMs: time, text: id, final: true }));
  }
  const runtime = snapshotRuntime(session.id);
  runtime.recording.turns = buffer.turns();
  const before = assembleSnapshot(store, runtime).selected.turns;
  const after = assembleSnapshot(store, { ...runtime, recording: null }).selected.turns;
  assert.deepEqual(after.map(t => t.id), before.map(t => t.id));
  assert.deepEqual(after.map(t => t.tStartMs), [1000, 5000]);
});

test("selected live detail includes the entire in-memory draft while history keeps its own text", () => {
  const dir = tmpRoot();
  writeSession(dir, "history", "2026-08-19T00:00:00.000Z");
  const historicalTurn = { id: "turn-0", track: "other", speaker: "王明", tStartMs: 4000, text: "独立的历史正文" };
  writeFileSync(join(dir, "sessions", "history", "live.jsonl"), JSON.stringify(historicalTurn));
  const store = createSessionStore(dir);
  const live = store.createRecording();
  const turns = Array.from({ length: 13 }, (_, i) => ({
    id: `turn-${i}`, track: i % 2 ? "other" : "you", speaker: i % 2 ? "对方" : "你",
    tStartMs: i * 1000, text: `完整稿 ${i}`, ...(i === 12 ? { partial: true } : {}),
  }));
  const runtime = { ...snapshotRuntime(live.id), recording: {
    sessionId: live.id, startedAt: live.startedAt, glanceVisible: false, turns,
  }};
  const snap = assembleSnapshot(store, runtime);
  assert.deepEqual(snap.selected.turns, turns);
  assert.equal(snap.selected.turns[0].text, "完整稿 0");
  const historical = assembleSnapshot(store, { ...runtime, selectedId: "history" }).selected.turns;
  assert.deepEqual(historical.map(({ correction, ...turn }) => turn), [historicalTurn]);
  assert.equal(historical[0].correction.originalText, historicalTurn.text);
  assert.equal(historical[0].correction.edited, false);
  assert.deepEqual(assembleSnapshot(store, runtime).selected.turns, turns);
});

function writeSession(dir, id, startedAt, status = "complete", durationSec = 0) {
  const sessionDir = join(dir, "sessions", id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify({
      schema_version: 1,
      id,
      title: id,
      startedAt,
      endedAt: null,
      durationSec,
      status,
      audio: { sampleRate: 16000, channels: 1, codec: "pcm_s16le" },
      tracks: { microphone: true, system: true },
      jobs: {
        live: "idle",
        refined: { status: "idle", current: null },
        speakers: { status: "idle", current: null },
      },
    }),
  );
}

function writePcmWav(path, durationSec) {
  const dataBytes = durationSec * 16000 * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  const fd = openSync(path, "w");
  writeSync(fd, header);
  ftruncateSync(fd, 44 + dataBytes);
  closeSync(fd);
}

test("createRecording writes a recording session.json", () => {
  const store = createSessionStore(tmpRoot());
  const created = store.createRecording();
  const raw = JSON.parse(readFileSync(join(root, "sessions", created.id, "session.json"), "utf8"));
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.id, created.id);
  assert.equal(raw.status, "recording");
  assert.equal(raw.jobs.live, "running");
  assert.equal(raw.jobs.refined.status, "idle");
  assert.equal(raw.jobs.speakers.status, "idle");
});

test("listSummaries sorts newest startedAt first", () => {
  const dir = tmpRoot();
  writeSession(dir, "older", "2026-01-01T00:00:00.000Z");
  writeSession(dir, "newer", "2026-06-01T00:00:00.000Z");
  const listed = createSessionStore(dir).listSummaries();
  assert.deepEqual(
    listed.map((row) => row.id),
    ["newer", "older"],
  );
});

test("listSummaries skips folders that have no session.json", () => {
  const dir = tmpRoot();
  writeSession(dir, "kept", "2026-03-01T00:00:00.000Z");
  mkdirSync(join(dir, "sessions", "orphan"), { recursive: true });
  writeFileSync(join(dir, "sessions", "orphan", "mic.wav"), "not-a-session");
  const listed = createSessionStore(dir).listSummaries();
  assert.deepEqual(
    listed.map((row) => row.id),
    ["kept"],
  );
});

test("renameSpeaker writes names.json and people.json", () => {
  const store = createSessionStore(tmpRoot());
  const created = store.createRecording();
  const result = store.renameSpeaker({ sessionId: created.id, from: "小 A", to: "王明" });
  assert.equal(result.ok, true);
  const names = createSessionStore(root).readNames(created.id);
  const people = JSON.parse(readFileSync(join(root, "people.json"), "utf8"));
  assert.equal(names["小 A"], "王明");
  assert.deepEqual(people, ["王明"]);
});

test("renameSpeaker rejects a blank name", () => {
  const store = createSessionStore(tmpRoot());
  const created = store.createRecording();
  assert.deepEqual(store.renameSpeaker({ sessionId: created.id, from: "小 A", to: "" }), {
    ok: false,
    error: "名字不能为空",
  });
  assert.deepEqual(store.renameSpeaker({ sessionId: created.id, from: "  ", to: "王明" }), {
    ok: false,
    error: "名字不能为空",
  });
});

test("renameSpeaker rejects an unknown session", () => {
  const store = createSessionStore(tmpRoot());
  assert.deepEqual(store.renameSpeaker({ sessionId: "missing", from: "小 A", to: "王明" }), {
    ok: false,
    error: "找不到这场会",
  });
});

test("renameSpeaker follows a previous rename and appends people.json", () => {
  const store = createSessionStore(tmpRoot());
  const created = store.createRecording();
  store.renameSpeaker({ sessionId: created.id, from: "小 A", to: "王明" });
  const again = store.renameSpeaker({ sessionId: created.id, from: "王明", to: "李雷" });
  assert.equal(again.ok, true);
  const names = createSessionStore(root).readNames(created.id);
  const people = JSON.parse(readFileSync(join(root, "people.json"), "utf8"));
  assert.equal(names["小 A"], "李雷");
  assert.equal(names["王明"], "李雷");
  assert.deepEqual(people, ["王明", "李雷"]);
});

test("getDetail reads live.jsonl and applies names", () => {
  const store = createSessionStore(tmpRoot());
  const created = store.createRecording();
  writeFileSync(
    join(root, "sessions", created.id, "live.jsonl"),
    `${JSON.stringify({ id: "l1", track: "other", speaker: "小 A", tStartMs: 0, text: "你好" })}\n`,
  );
  store.renameSpeaker({ sessionId: created.id, from: "小 A", to: "王明" });
  const detail = store.getDetail(created.id);
  assert.equal(detail.turns.length, 1);
  assert.equal(detail.turns[0].speaker, "王明");
  assert.deepEqual(detail.people, ["王明"]);
});

test("getDetail does not apply auto-names.json", () => {
  const store = createSessionStore(tmpRoot());
  const created = store.createRecording();
  writeFileSync(
    join(root, "sessions", created.id, "live.jsonl"),
    `${JSON.stringify({ id: "l1", track: "other", speaker: "小 A", tStartMs: 0, text: "你好" })}\n`,
  );
  writeFileSync(
    join(root, "sessions", created.id, "auto-names.json"),
    `${JSON.stringify({ "小 A": "王明" }, null, 2)}\n`,
  );
  const detail = store.getDetail(created.id);
  assert.equal(detail.turns[0].speaker, "小 A");
  assert.equal(detail.people.includes("王明"), false);
});

test("assembleSnapshot lists sorted sessions and the selected detail", () => {
  const dir = tmpRoot();
  writeSession(dir, "older", "2026-01-01T00:00:00.000Z");
  writeSession(dir, "newer", "2026-06-01T00:00:00.000Z");
  const store = createSessionStore(dir);
  store.setAutoDiarize(false);
  const snap = assembleSnapshot(store, {
    hasApiKey: true,
    permissions: { microphone: "granted", screen: "denied" },
    recording: null,
    playingSessionId: null,
    selectedId: "older",
  });
  assert.equal(snap.hasApiKey, true);
  assert.equal(snap.autoDiarize, false);
  assert.equal(snap.permissions.screen, "denied");
  assert.deepEqual(
    snap.sessions.map((row) => row.id),
    ["newer", "older"],
  );
  assert.equal(snap.selectedId, "older");
  assert.equal(snap.selected?.id, "older");
  assert.equal(snap.selected?.endedAt, null);
  assert.deepEqual(snap.selected?.turns, []);
  assert.equal(snap.recording, null);
});

test("assembleSnapshot keeps a stale disk edit until the store writes", () => {
  const dir = tmpRoot();
  writeSession(dir, "older", "2026-01-01T00:00:00.000Z");
  const store = createSessionStore(dir);
  const runtime = { ...snapshotRuntime("older"), recording: null };
  const first = assembleSnapshot(store, runtime);
  assert.equal(first.selected?.title, "older");

  const sessionPath = join(dir, "sessions", "older", "session.json");
  const raw = JSON.parse(readFileSync(sessionPath, "utf8"));
  raw.title = "disk-changed";
  writeFileSync(sessionPath, `${JSON.stringify(raw, null, 2)}\n`);

  const stale = assembleSnapshot(store, runtime);
  assert.equal(stale.selected?.title, "older");
  assert.equal(stale.sessions.find((row) => row.id === "older")?.title, "older");

  store.patchJobs("older", { live: "failed" });
  const fresh = assembleSnapshot(store, runtime);
  assert.equal(fresh.selected?.jobs.live, "failed");
  assert.equal(fresh.selected?.title, "disk-changed");
});

test("assembleSnapshot sees live.jsonl append after a prior snapshot", () => {
  const store = createSessionStore(tmpRoot());
  const created = store.createRecording();
  const livePath = join(root, "sessions", created.id, "live.jsonl");
  writeFileSync(
    livePath,
    `${JSON.stringify({ id: "l1", track: "other", speaker: "对方", tStartMs: 0, text: "先" })}\n`,
  );
  const runtime = snapshotRuntime(created.id);
  assert.equal(assembleSnapshot(store, runtime).selected?.turns.length, 1);
  writeFileSync(
    livePath,
    `${JSON.stringify({ id: "l1", track: "other", speaker: "对方", tStartMs: 0, text: "先" })}\n${JSON.stringify({ id: "l2", track: "other", speaker: "对方", tStartMs: 10, text: "后" })}\n`,
  );
  const snap = assembleSnapshot(store, runtime);
  assert.equal(snap.selected?.turns.length, 2);
  assert.equal(snap.selected?.turns[1].text, "后");
});

test("assembleSnapshot sees renameSpeaker after a prior snapshot", () => {
  const store = createSessionStore(tmpRoot());
  const created = store.createRecording();
  writeFileSync(
    join(root, "sessions", created.id, "live.jsonl"),
    `${JSON.stringify({ id: "l1", track: "other", speaker: "小 A", tStartMs: 0, text: "你好" })}\n`,
  );
  const runtime = snapshotRuntime(created.id);
  assert.equal(assembleSnapshot(store, runtime).selected?.turns[0].speaker, "小 A");
  store.renameSpeaker({ sessionId: created.id, from: "小 A", to: "王明" });
  const snap = assembleSnapshot(store, runtime);
  assert.equal(snap.selected?.turns[0].speaker, "王明");
  assert.deepEqual(snap.selected?.people, ["王明"]);
});

test("assembleSnapshot merges jobFailReasons only while the job is failed", () => {
  const store = createSessionStore(tmpRoot());
  const created = store.createRecording();
  store.finalize(created.id, "complete");
  store.patchJobs(created.id, { refined: { status: "failed" }, speakers: { status: "failed" } });
  const reasons = new Map([[created.id, { refined: "网络不通", speakers: "分离失败" }]]);
  const runtime = { ...snapshotRuntime(created.id), recording: null, jobFailReasons: reasons };
  const failed = assembleSnapshot(store, runtime);
  assert.equal(failed.selected?.jobs.failedReason, "网络不通");
  assert.equal(failed.selected?.jobs.speakersFailReason, "分离失败");
  assert.equal(failed.sessions.find((row) => row.id === created.id)?.jobs.failedReason, "网络不通");

  store.patchJobs(created.id, { refined: { status: "done" }, speakers: { status: "done" } });
  const done = assembleSnapshot(store, runtime);
  assert.equal(done.selected?.jobs.failedReason, undefined);
  assert.equal(done.selected?.jobs.speakersFailReason, undefined);
});

test("assembleSnapshot sees session writes after a prior snapshot", () => {
  const dir = tmpRoot();
  writeSession(dir, "older", "2026-01-01T00:00:00.000Z");
  const store = createSessionStore(dir);
  const base = {
    hasApiKey: true,
    permissions: { microphone: "granted", screen: "granted" },
    recording: null,
    playingSessionId: null,
    selectedId: "older",
  };
  assert.deepEqual(
    assembleSnapshot(store, base).sessions.map((row) => row.id),
    ["older"],
  );

  const created = store.createRecording();
  const afterCreate = assembleSnapshot(store, { ...base, selectedId: created.id });
  assert.equal(afterCreate.sessions[0].id, created.id);
  assert.equal(afterCreate.selected?.status, "recording");

  store.patchJobs(created.id, { live: "failed", refined: { status: "running" } });
  const afterPatch = assembleSnapshot(store, { ...base, selectedId: created.id });
  assert.equal(afterPatch.selected?.jobs.live, "failed");
  assert.equal(afterPatch.selected?.jobs.refined, "running");
  assert.equal(afterPatch.sessions.find((row) => row.id === created.id)?.jobs.live, "failed");

  store.finalize(created.id, "complete", { durationSec: 42 });
  const afterFin = assembleSnapshot(store, { ...base, selectedId: created.id });
  assert.equal(afterFin.selected?.status, "complete");
  assert.equal(afterFin.selected?.durationSec, 42);
  assert.equal(afterFin.sessions.find((row) => row.id === created.id)?.status, "complete");
});

test("recoverOrphans uses wav duration not wall clock and leaves complete sessions", () => {
  const dir = tmpRoot();
  const startedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  writeSession(dir, "orphan", startedAt, "recording", 0);
  writePcmWav(join(dir, "sessions", "orphan", "mic.wav"), 90);
  writeSession(dir, "kept", "2026-01-01T00:00:00.000Z", "complete", 42);
  const store = createSessionStore(dir);
  store.recoverOrphans();
  const orphan = store.readSession("orphan");
  assert.equal(orphan.status, "incomplete");
  assert.equal(orphan.durationSec, 90);
  const kept = store.readSession("kept");
  assert.equal(kept.status, "complete");
  assert.equal(kept.durationSec, 42);
});

test("recoverOrphans repairs placeholder wav headers", () => {
  const dir = tmpRoot();
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  writeSession(dir, "orphan", startedAt, "recording", 0);
  const wavPath = join(dir, "sessions", "orphan", "mic.wav");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(0, 40);
  writeFileSync(wavPath, Buffer.concat([header, Buffer.alloc(3200, 7)]));
  createSessionStore(dir).recoverOrphans();
  const wav = readFileSync(wavPath);
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
});

test("listSummaries skips a session.json that is not valid JSON", () => {
  const dir = tmpRoot();
  writeSession(dir, "kept", "2026-03-01T00:00:00.000Z");
  mkdirSync(join(dir, "sessions", "broken"), { recursive: true });
  writeFileSync(join(dir, "sessions", "broken", "session.json"), "not-json");
  const listed = createSessionStore(dir).listSummaries();
  assert.deepEqual(
    listed.map((row) => row.id),
    ["kept"],
  );
});

test("readPeople returns [] when people.json is an object", () => {
  const dir = tmpRoot();
  writeFileSync(join(dir, "people.json"), JSON.stringify({ name: "王明" }));
  assert.deepEqual(createSessionStore(dir).readPeople(), []);
});

test("readPrefs defaults autoDiarize to true when prefs.json is corrupt", () => {
  const dir = tmpRoot();
  writeFileSync(join(dir, "prefs.json"), "not-json");
  assert.equal(createSessionStore(dir).readPrefs().autoDiarize, true);
});

test("renameSpeaker does not append a duplicate name to people.json", () => {
  const store = createSessionStore(tmpRoot());
  const created = store.createRecording();
  store.renameSpeaker({ sessionId: created.id, from: "小 A", to: "王明" });
  store.renameSpeaker({ sessionId: created.id, from: "小 B", to: "王明" });
  assert.deepEqual(JSON.parse(readFileSync(join(root, "people.json"), "utf8")), ["王明"]);
});

test("recoverOrphans uses system.wav duration when only that track has a body", () => {
  const dir = tmpRoot();
  const startedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  writeSession(dir, "orphan", startedAt, "recording", 0);
  writePcmWav(join(dir, "sessions", "orphan", "system.wav"), 75);
  const store = createSessionStore(dir);
  store.recoverOrphans();
  assert.equal(store.readSession("orphan").durationSec, 75);
});

test("discardEmptyRecording deletes a session with no wav body", () => {
  const store = createSessionStore(tmpRoot());
  const created = store.createRecording();
  writeFileSync(join(root, "sessions", created.id, "mic.wav"), Buffer.alloc(44));
  writeFileSync(join(root, "sessions", created.id, "system.wav"), Buffer.alloc(44));
  assert.equal(store.discardEmptyRecording(created.id), true);
  assert.equal(store.readSession(created.id), null);
  assert.deepEqual(readdirSync(join(root, "sessions")), []);
});

test("discardEmptyRecording keeps a session that already has audio", () => {
  const store = createSessionStore(tmpRoot());
  const created = store.createRecording();
  writePcmWav(join(root, "sessions", created.id, "mic.wav"), 2);
  assert.equal(store.discardEmptyRecording(created.id), false);
  assert.equal(store.readSession(created.id)?.status, "recording");
});

test('store refuses traversal before reading or writing an outside session', () => {
  const store = createSessionStore(tmpRoot());
  const doc = store.createRecording();
  const outside = join(root, 'outside'); mkdirSync(outside);
  const path = join(outside, 'session.json'); writeFileSync(path, JSON.stringify(doc));
  const before = readFileSync(path, 'utf8');
  for (const id of ['../outside', '../../outside', outside, `nested/../${doc.id}`, '', '.']) {
    assert.equal(store.readSession(id), null);
    assert.throws(() => store.sessionDir(id), /会话/);
  }
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.ok(store.readSession(doc.id));
});
