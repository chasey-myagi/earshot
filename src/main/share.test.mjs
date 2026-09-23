import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { test } from "node:test";
import { copyTranscript, sharePath } from "./share.ts";
import { createSessionStore } from "./store/sessions.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "earshot-share-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(root);
  const session = store.createRecording();
  const turn = { id: "t1", track: "other", speaker: "小 A", tStartMs: 3725000, text: "实时稿" };
  writeFileSync(join(store.sessionDir(session.id), "live.jsonl"), JSON.stringify(turn) + "\n");
  store.finalize(session.id, "complete");
  const path = sharePath(store.sessionDir(session.id));
  return { root, store, id: session.id, turn, path };
}
function copy(store, id, kind = "agent") {
  let clipboard = "";
  const result = copyTranscript(store, { sessionId: id, kind }, text => { clipboard = text; });
  return { result, clipboard };
}

test("agent copy creates a private readable file and copies its absolute path, without a save dialog", t => {
  const { root, store, id, path } = fixture(t);
  writeFileSync(join(root, "key"), "never-share-secret");
  writeFileSync(join(root, "people.json"), '["unrelated-person"]');
  store.renameSpeaker({ sessionId: id, from: "小 A", to: "王明" });
  assert.equal(existsSync(path), false);
  const { result, clipboard } = copy(store, id);
  assert.deepEqual(result, { ok: true });
  assert.ok(isAbsolute(path));
  assert.ok(clipboard.includes(path));
  assert.ok(!clipboard.includes("实时稿"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const text = readFileSync(path, "utf8");
  assert.match(text, /更新时间：/);
  assert.match(text, /\[01:02:05\] 王明：实时稿/);
  assert.doesNotMatch(text, /never-share-secret|unrelated-person/);
});

test("a shared path survives refinement, speaker and title changes, and store recreation", t => {
  const { root, store, id, turn, path } = fixture(t);
  copy(store, id);
  store.patchJobs(id, { refined: { status: "running" } });
  assert.match(readFileSync(path, "utf8"), /处理中/);
  writeFileSync(join(store.sessionDir(id), "refined-v1.json"), JSON.stringify({ turns: [
    { ...turn, text: "精修稿" }, { ...turn, id: "partial", text: "未确认", partial: true },
    { ...turn, id: "blank", text: "  " },
  ] }));
  store.patchJobs(id, { refined: { status: "done", current: "refined-v1.json" } });
  assert.match(readFileSync(path, "utf8"), /精修稿/);
  assert.doesNotMatch(readFileSync(path, "utf8"), /实时稿|未确认|处理中/);
  const reopened = createSessionStore(root);
  reopened.renameSpeaker({ sessionId: id, from: "小 A", to: "李老师" });
  const doc = reopened.readSession(id); doc.title = "重新命名"; reopened.writeSession(doc);
  assert.match(readFileSync(path, "utf8"), /# 重新命名/);
  assert.match(readFileSync(path, "utf8"), /李老师：精修稿/);
  assert.ok(copy(reopened, id).clipboard.includes(path));
  assert.equal(readdirSync(store.sessionDir(id)).filter(n => n.endsWith(".tmp")).length, 0);
});

test("full-text copy works without activating file sharing", t => {
  const { store, id, path } = fixture(t);
  const { result, clipboard } = copy(store, id, "text");
  assert.deepEqual(result, { ok: true }); assert.match(clipboard, /实时稿/);
  store.renameSpeaker({ sessionId: id, from: "小 A", to: "名字" });
  assert.equal(existsSync(path), false);
});

test("invalid, missing, recording, and empty sessions leave the clipboard untouched", t => {
  const { store, id } = fixture(t);
  let calls = 0;
  for (const input of [null, {}, { sessionId: "../key", kind: "agent" }, { sessionId: id, kind: "bad" }, { sessionId: "missing", kind: "text" }]) {
    assert.equal(copyTranscript(store, input, () => calls++).ok, false);
  }
  const recording = store.createRecording();
  assert.equal(copy(store, recording.id).result.ok, false);
  store.finalize(recording.id, "complete");
  assert.equal(copy(store, recording.id).result.ok, false);
  assert.equal(calls, 0);
});

test("clipboard and filesystem errors never report successful copy", t => {
  const { store, id, path } = fixture(t);
  assert.equal(copyTranscript(store, { sessionId: id, kind: "agent" }, () => { throw Error("clipboard unavailable"); }).ok, false);
  rmSync(path); mkdirSync(path);
  let touched = false;
  assert.equal(copyTranscript(store, { sessionId: id, kind: "agent" }, () => { touched = true; }).ok, false);
  assert.equal(touched, false);
  assert.equal(readdirSync(store.sessionDir(id)).filter(n => n.endsWith(".tmp")).length, 0);
});

test("atomic replacement does not follow a destination symlink", t => {
  const { root, store, id, path } = fixture(t);
  const victim = join(root, "key"); writeFileSync(victim, "secret"); symlinkSync(victim, path);
  assert.deepEqual(copy(store, id).result, { ok: true });
  assert.equal(readFileSync(victim, "utf8"), "secret");
  assert.match(readFileSync(path, "utf8"), /实时稿/);
});

test("removing a session also removes its shared file", t => {
  const { store, id, path } = fixture(t); copy(store, id);
  assert.equal(store.discardEmptyRecording(id), true);
  assert.equal(existsSync(path), false);
});

test("corrections, microphone speaker overrides, undo and direct name writes refresh the shared file", t => {
  const { store, id, turn, path } = fixture(t);
  writeFileSync(join(store.sessionDir(id), "refined-v1.json"), JSON.stringify({ turns: [{...turn,track:'you',speaker:'你'}] }));
  store.patchJobs(id, {refined:{status:'done',current:'refined-v1.json'}});
  copy(store,id);
  const input = extra => ({sessionId:id,turnId:turn.id,revision:store.getDetail(id).turns[0].correction.revision,...extra});
  assert.deepEqual(store.correctTurn(input({text:'修正后的内容',speaker:'同事'})),{ok:true});
  assert.match(readFileSync(path,'utf8'),/同事：修正后的内容/);
  assert.deepEqual(store.undoTurnCorrection(input({})),{ok:true});
  assert.match(readFileSync(path,'utf8'),/你：实时稿/);
  writeFileSync(join(store.sessionDir(id), "refined-v2.json"), JSON.stringify({ turns: [turn] }));
  store.patchJobs(id,{refined:{status:'done',current:'refined-v2.json'}});
  store.writeNames(id, {'小 A':'写入名字'});
  assert.match(readFileSync(path,'utf8'),/写入名字：实时稿/);
});
