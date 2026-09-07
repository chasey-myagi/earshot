import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { test } from "node:test";
import { exportTranscript } from "./export.ts";
import { createSessionStore } from "./store/sessions.ts";

const STARTED_AT = "2026-09-06T01:02:03.000Z";
const ENDED_AT = "2026-09-06T02:04:08.000Z";

function turn(overrides = {}) {
  return {
    id: "turn-1",
    track: "other",
    speaker: "小 A",
    tStartMs: 1200,
    text: "已确认的转录正文",
    ...overrides,
  };
}

function setRefined(store, sessionId, turns, filename = "refined-v1.json") {
  writeFileSync(join(store.sessionDir(sessionId), filename), JSON.stringify({ turns }));
  store.patchJobs(sessionId, { refined: { status: "done", current: filename } });
}

function fixture(t, { status = "complete", title = "产品讨论", turns = [turn()] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "earshot-export-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(join(root, "support"));
  const exportsDir = join(root, "exports");
  mkdirSync(exportsDir);
  const doc = store.createRecording();
  doc.title = title;
  doc.startedAt = STARTED_AT;
  store.writeSession(doc);
  if (status !== "recording") {
    store.finalize(doc.id, status, { durationSec: 3725, endedAt: ENDED_AT });
  }
  if (turns !== null) setRefined(store, doc.id, turns);
  return { root, store, exportsDir, sessionId: doc.id };
}

function assertFailure(result, message) {
  assert.equal(result.ok, false, message);
  assert.equal(typeof result.error, "string", message);
  assert.ok(result.error.trim().length > 0, message);
}

function safeFilename(filename, format) {
  assert.equal(typeof filename, "string");
  assert.equal(basename(filename), filename);
  assert.doesNotMatch(filename, /[\\/\x00-\x1f\x7f<>:"|?*]/);
  assert.equal(extname(filename), `.${format}`);
  assert.ok(filename.slice(0, -format.length - 1).trim().length > 0);
  assert.notEqual(filename, `..${format}`);
}

test("JSON exports the current refined text, renamed speakers, and only the documented fields", async (t) => {
  const rawText = "  她说：\"开始\"。\n下一行保留“中文引号”与空格。  ";
  const { store, exportsDir, sessionId } = fixture(t, {
    turns: [
      turn({ id: "later-first", tStartMs: 3725000, tEndMs: 3725999, text: rawText, internal: "private turn metadata", key: "turn-secret" }),
      turn({ id: "mic-second", track: "you", speaker: "错误的麦克风名字", tStartMs: 10, text: "我的回答", partial: false }),
      turn({ id: "partial", text: "尚未确认", partial: true }),
      turn({ id: "empty", text: " \t\n " }),
    ],
  });
  writeFileSync(join(store.sessionDir(sessionId), "live.jsonl"), `${JSON.stringify(turn({ text: "过时的实时稿" }))}\n`);
  writeFileSync(join(store.rootDir, "people.json"), JSON.stringify(["不在本场会的私人联系人"]));
  writeFileSync(join(store.rootDir, "dashscope-key.json"), JSON.stringify({ key: "secret-never-export" }));
  assert.deepEqual(store.renameSpeaker({ sessionId, from: "小 A", to: "张老师" }), { ok: true });
  const outputPath = join(exportsDir, "transcript.json");
  let calls = 0;
  const result = await exportTranscript(store, { sessionId, format: "json" }, async (filename, format) => {
    calls += 1;
    assert.equal(format, "json");
    safeFilename(filename, format);
    return outputPath;
  });
  assert.deepEqual(result, { ok: true, canceled: false });
  assert.equal(calls, 1);
  const output = readFileSync(outputPath, "utf8");
  assert.ok(output.endsWith("\n"));
  assert.deepEqual(JSON.parse(output), {
    schema_version: 1,
    session: {
      id: sessionId,
      title: "产品讨论",
      startedAt: STARTED_AT,
      endedAt: ENDED_AT,
      durationSec: 3725,
      status: "complete",
    },
    turns: [
      { id: "later-first", track: "other", speaker: "张老师", tStartMs: 3725000, tEndMs: 3725999, text: rawText },
      { id: "mic-second", track: "you", speaker: "你", tStartMs: 10, text: "我的回答" },
    ],
  });
});

test("TXT keeps title, start time, original text, names, order, and hours beyond one hour", async (t) => {
  const body = "  “保留原文”\n第二行。  ";
  const { store, exportsDir, sessionId } = fixture(t, {
    turns: [
      turn({ id: "a", tStartMs: 3725999, text: body }),
      turn({ id: "b", track: "you", speaker: "小 B", tStartMs: 0, text: "好的" }),
      turn({ id: "c", tStartMs: 1234, text: "后续" }),
      turn({ id: "d", partial: true, text: "不能导出的临时片段" }),
      turn({ id: "e", text: " \t " }),
    ],
  });
  store.renameSpeaker({ sessionId, from: "小 A", to: "张老师" });
  const outputPath = join(exportsDir, "transcript.txt");
  assert.deepEqual(await exportTranscript(store, { sessionId, format: "txt" }, async () => outputPath), { ok: true, canceled: false });
  const output = readFileSync(outputPath, "utf8");
  assert.equal(output.split("\n")[0], "产品讨论");
  assert.ok(output.includes(STARTED_AT), "the exported start time must identify this session");
  const expectedBody = `[01:02:05] 张老师：${body}\n[00:00:00] 你：好的\n[00:00:01] 张老师：后续\n`;
  assert.ok(output.endsWith(expectedBody), output);
  assert.equal(output.includes("不能导出的临时片段"), false);
});

test("a stopped session exports its renamed live transcript while refinement is still running", async (t) => {
  const { store, exportsDir, sessionId } = fixture(t, { turns: null });
  const live = turn({ text: "实时稿，已确认。" });
  writeFileSync(join(store.sessionDir(sessionId), "live.jsonl"), `${JSON.stringify(live)}\n`);
  store.patchJobs(sessionId, { refined: { status: "running", current: null } });
  store.renameSpeaker({ sessionId, from: "小 A", to: "李同学" });
  const outputPath = join(exportsDir, "live.json");
  assert.deepEqual(await exportTranscript(store, { sessionId, format: "json" }, async () => outputPath), { ok: true, canceled: false });
  assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")).turns, [{ ...live, speaker: "李同学" }]);
});

test("a missing current refined artifact uses the store's live transcript fallback", async (t) => {
  const { store, exportsDir, sessionId } = fixture(t, { turns: null });
  const live = turn({ text: "可恢复的实时稿" });
  writeFileSync(join(store.sessionDir(sessionId), "live.jsonl"), `${JSON.stringify(live)}\n`);
  store.patchJobs(sessionId, { refined: { status: "failed", current: "missing-refined.json" } });
  const outputPath = join(exportsDir, "fallback.json");
  assert.deepEqual(await exportTranscript(store, { sessionId, format: "json" }, async () => outputPath), { ok: true, canceled: false });
  assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")).turns, [live]);
});

test("an incomplete but stopped recording with confirmed text can be exported", async (t) => {
  const { store, exportsDir, sessionId } = fixture(t, { status: "incomplete" });
  const outputPath = join(exportsDir, "recovered.json");
  assert.deepEqual(await exportTranscript(store, { sessionId, format: "json" }, async () => outputPath), { ok: true, canceled: false });
  assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).session.status, "incomplete");
});

test("an active recording is rejected before opening the save dialog", async (t) => {
  const { store, sessionId } = fixture(t, { status: "recording" });
  let opened = false;
  assertFailure(await exportTranscript(store, { sessionId, format: "txt" }, async () => { opened = true; return null; }));
  assert.equal(opened, false);
});

for (const [label, turns] of [
  ["no transcript", []],
  ["only blank or unconfirmed text", [turn({ text: " \n\t " }), turn({ text: "还在识别", partial: true })]],
]) {
  test(`a session with ${label} is rejected before opening the save dialog`, async (t) => {
    const { store, sessionId } = fixture(t, { turns });
    let opened = false;
    assertFailure(await exportTranscript(store, { sessionId, format: "json" }, async () => { opened = true; return null; }));
    assert.equal(opened, false);
  });
}

for (const format of ["json", "txt"]) {
  test(`${format} proposes a single safe filename even when the title contains paths and control characters`, async (t) => {
    const { store, sessionId } = fixture(t, { title: "../产品\\讨论\n第二场\t<客户>: \"A\"|?*\u0000" });
    let proposed;
    assert.deepEqual(await exportTranscript(store, { sessionId, format }, async (filename, receivedFormat) => {
      proposed = filename;
      assert.equal(receivedFormat, format);
      safeFilename(filename, format);
      assert.ok(filename.includes("产品"), "filename keeps recognizable Chinese title text");
      return null;
    }), { ok: true, canceled: true });
    assert.ok(proposed);
  });
}

test("an empty title still produces a usable filename", async (t) => {
  const { store, sessionId } = fixture(t, { title: "" });
  let proposed;
  assert.deepEqual(await exportTranscript(store, { sessionId, format: "txt" }, async (filename) => {
    proposed = filename;
    safeFilename(filename, "txt");
    return null;
  }), { ok: true, canceled: true });
  assert.ok(proposed);
});

test("malformed requests and unsupported formats fail before opening the dialog", async (t) => {
  const { store, sessionId } = fixture(t);
  const inputs = [null, undefined, "json", [], {}, { sessionId }, { sessionId, format: "csv" }, { sessionId, format: "JSON" }, { sessionId, format: 1 }, { sessionId: 1, format: "json" }];
  for (const input of inputs) {
    let opened = false;
    assertFailure(await exportTranscript(store, input, async () => { opened = true; return null; }), JSON.stringify(input));
    assert.equal(opened, false, JSON.stringify(input));
  }
});

test("a nonexistent session fails before opening the dialog", async (t) => {
  const { store } = fixture(t);
  let opened = false;
  assertFailure(await exportTranscript(store, { sessionId: "00000000-0000-4000-8000-000000000000", format: "txt" }, async () => { opened = true; return null; }));
  assert.equal(opened, false);
});

test("path traversal session IDs cannot export an otherwise readable session outside sessions", async (t) => {
  const { store, sessionId } = fixture(t);
  const outsideDir = join(store.rootDir, "outside");
  mkdirSync(outsideDir);
  writeFileSync(join(outsideDir, "session.json"), JSON.stringify(store.readSession(sessionId)));
  writeFileSync(join(outsideDir, "refined-v1.json"), JSON.stringify({ turns: [turn({ text: "私有的越界内容" })] }));
  assert.ok(JSON.parse(readFileSync(join(outsideDir, "session.json"), "utf8")), "outside fixture exists independently of store guards");
  assert.equal(store.getDetail("../outside"), null);
  for (const invalidId of ["../outside", `../sessions/${sessionId}`, `./${sessionId}`, `nested/../${sessionId}`, `..\\${sessionId}`, "", ".", "..", outsideDir]) {
    let opened = false;
    assertFailure(await exportTranscript(store, { sessionId: invalidId, format: "json" }, async () => { opened = true; return null; }), invalidId);
    assert.equal(opened, false, invalidId);
  }
});

test("canceling the save dialog writes no export and preserves the session", async (t) => {
  const { store, exportsDir, sessionId } = fixture(t);
  const sourcePath = join(store.sessionDir(sessionId), "session.json");
  const before = readFileSync(sourcePath);
  assert.deepEqual(await exportTranscript(store, { sessionId, format: "json" }, async () => null), { ok: true, canceled: true });
  assert.deepEqual(readdirSync(exportsDir), []);
  assert.deepEqual(readFileSync(sourcePath), before);
});

test("a save dialog failure returns a displayable error instead of rejecting", async (t) => {
  const { store, exportsDir, sessionId } = fixture(t);
  assertFailure(await exportTranscript(store, { sessionId, format: "txt" }, async () => { throw new Error("保存对话框不可用"); }));
  assert.deepEqual(readdirSync(exportsDir), []);
});

test("a file write failure returns a displayable error instead of rejecting", async (t) => {
  const { store, exportsDir, sessionId } = fixture(t);
  const directoryInsteadOfFile = join(exportsDir, "existing-directory");
  mkdirSync(directoryInsteadOfFile);
  assertFailure(await exportTranscript(store, { sessionId, format: "txt" }, async () => directoryInsteadOfFile));
  assert.deepEqual(readdirSync(directoryInsteadOfFile), []);
});

test("exports cannot overwrite existing session data or create files inside the support root", async (t) => {
  const { store, sessionId } = fixture(t);
  const sourcePath = join(store.sessionDir(sessionId), "session.json");
  const before = readFileSync(sourcePath);
  assertFailure(await exportTranscript(store, { sessionId, format: "json" }, async () => sourcePath));
  assert.deepEqual(readFileSync(sourcePath), before);
  const forbiddenNewFile = join(store.rootDir, "transcript.txt");
  assertFailure(await exportTranscript(store, { sessionId, format: "txt" }, async () => forbiddenNewFile));
  assert.equal(existsSync(forbiddenNewFile), false);
});

test("a parent directory symlink into the support root cannot bypass source protection", async (t) => {
  const { root, store, sessionId } = fixture(t);
  const shortcut = join(root, "support-shortcut");
  symlinkSync(store.rootDir, shortcut, "dir");
  assertFailure(await exportTranscript(store, { sessionId, format: "txt" }, async () => join(shortcut, "transcript.txt")));
  assert.equal(existsSync(join(store.rootDir, "transcript.txt")), false);
});

test("a target file symlink into the support root cannot overwrite source data", async (t) => {
  const { store, exportsDir, sessionId } = fixture(t);
  const sourcePath = join(store.sessionDir(sessionId), "refined-v1.json");
  const before = readFileSync(sourcePath);
  const shortcut = join(exportsDir, "transcript.json");
  symlinkSync(sourcePath, shortcut, "file");
  assertFailure(await exportTranscript(store, { sessionId, format: "json" }, async () => shortcut));
  assert.deepEqual(readFileSync(sourcePath), before);
});

test("a neighboring output directory with the same prefix as the support root is allowed", async (t) => {
  const { store, sessionId } = fixture(t);
  const neighbor = `${store.rootDir}-exports`;
  mkdirSync(neighbor);
  const outputPath = join(neighbor, "transcript.txt");
  assert.deepEqual(await exportTranscript(store, { sessionId, format: "txt" }, async () => outputPath), { ok: true, canceled: false });
  assert.ok(readFileSync(outputPath, "utf8").includes("已确认的转录正文"));
});

test("the exported content is frozen before the save dialog while the store continues changing", async (t) => {
  const { store, exportsDir, sessionId } = fixture(t, { turns: [turn({ text: "打开对话框前的正文" })] });
  store.renameSpeaker({ sessionId, from: "小 A", to: "原来的名字" });
  const outputPath = join(exportsDir, "snapshot.json");
  const result = await exportTranscript(store, { sessionId, format: "json" }, async () => {
    const updated = store.readSession(sessionId);
    updated.title = "后来改过的标题";
    store.writeSession(updated);
    setRefined(store, sessionId, [turn({ text: "对话框打开后的精修正文" })], "refined-v2.json");
    store.renameSpeaker({ sessionId, from: "原来的名字", to: "后来改过的名字" });
    return outputPath;
  });
  assert.deepEqual(result, { ok: true, canceled: false });
  const output = JSON.parse(readFileSync(outputPath, "utf8"));
  assert.equal(output.session.title, "产品讨论");
  assert.deepEqual(output.turns, [turn({ speaker: "原来的名字", text: "打开对话框前的正文" })]);
  assert.equal(store.getDetail(sessionId).title, "后来改过的标题");
  assert.equal(store.getDetail(sessionId).turns[0].text, "对话框打开后的精修正文");
});

test("a dangling output symlink cannot create a new file inside the support root", async (t) => {
  const { store, exportsDir, sessionId } = fixture(t);
  const forbiddenNewFile = join(store.rootDir, "not-yet-created.json");
  const shortcut = join(exportsDir, "transcript.json");
  symlinkSync(forbiddenNewFile, shortcut, "file");
  assert.equal(existsSync(forbiddenNewFile), false);
  assertFailure(await exportTranscript(store, { sessionId, format: "json" }, async () => shortcut));
  assert.equal(existsSync(forbiddenNewFile), false);
});

test("an existing empty refined artifact does not fall back to stale live text", async (t) => {
  const { store, sessionId } = fixture(t, { turns: [] });
  writeFileSync(join(store.sessionDir(sessionId), "live.jsonl"), `${JSON.stringify(turn({ text: "过时但非空的实时稿" }))}\n`);
  assert.deepEqual(store.getDetail(sessionId).turns, [], "the current store result is an empty refined transcript");
  let opened = false;
  assertFailure(await exportTranscript(store, { sessionId, format: "json" }, async () => { opened = true; return null; }));
  assert.equal(opened, false);
});

test('only a completed atomic export publishes its saved location; canceled and failed exports do not', async t => {
  const { store, sessionId, exportsDir } = fixture(t);
  const saved = [], path = join(exportsDir, 'location.txt');
  assert.equal((await exportTranscript(store, { sessionId, format: 'txt' }, async () => path, p => saved.push(p))).ok, true);
  assert.deepEqual(saved, [realpathSync(path)]);
  assert.ok(readFileSync(saved[0], 'utf8').includes('已确认的转录正文'));
  await exportTranscript(store, { sessionId, format: 'txt' }, async () => null, p => saved.push(p));
  await exportTranscript(store, { sessionId, format: 'txt' }, async () => join(exportsDir, 'missing', 'x.txt'), p => saved.push(p));
  assert.deepEqual(saved, [realpathSync(path)]);
});
