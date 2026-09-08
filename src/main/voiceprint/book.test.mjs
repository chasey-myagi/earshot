import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { addVoiceprint, hasAnyVoiceprint, readVoiceBook } from "./book.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("addVoiceprint round-trips a float32 embedding as base64 JSON", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-book-"));
  assert.equal(hasAnyVoiceprint(root), false);
  const embedding = new Float32Array([0.5, -1, 0.25]);
  addVoiceprint(root, "王明", embedding);
  assert.equal(hasAnyVoiceprint(root), true);
  const book = readVoiceBook(root);
  assert.equal(book.length, 1);
  assert.equal(book[0].name, "王明");
  assert.deepEqual(Array.from(book[0].embeddings[0]), [0.5, -1, 0.25]);
  const raw = JSON.parse(readFileSync(join(root, "people-voice.json"), "utf8"));
  assert.equal(typeof raw.people[0].templates[0].embedding, "string");
  assert.equal(Buffer.from(raw.people[0].templates[0].embedding, "base64").length, 12);
});

test("hasAnyVoiceprint is false when people-voice.json is not JSON", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-book-"));
  writeFileSync(join(root, "people-voice.json"), "not-json");
  assert.equal(hasAnyVoiceprint(root), false);
});

test("addVoiceprint keeps the 3 newest embeddings per person", () => {
  root = mkdtempSync(join(tmpdir(), "earshot-book-"));
  addVoiceprint(root, "王明", new Float32Array([1]));
  addVoiceprint(root, "王明", new Float32Array([2]));
  addVoiceprint(root, "王明", new Float32Array([3]));
  addVoiceprint(root, "王明", new Float32Array([4]));
  const values = readVoiceBook(root)[0].embeddings.map((row) => row[0]);
  assert.deepEqual(values, [2, 3, 4]);
});

test('remembered people have stable identities and retrying one confirmed sample does not duplicate it', () => {
  root=mkdtempSync(join(tmpdir(),'earshot-person-id-'));
  const source={sessionId:'fixture-session',artifact:'speakers-v1.json',cluster:'A',segments:[{startMs:0,endMs:4000}]};
  addVoiceprint(root,'张三',new Float32Array([1,0]),source);
  const personId=readVoiceBook(root)[0].id; assert.match(personId,/^[0-9a-f-]{36}$/);
  addVoiceprint(root,'张三',new Float32Array([1,0]),source);
  assert.equal(readVoiceBook(root)[0].id,personId);
  assert.equal(readVoiceBook(root)[0].embeddings.length,1);
  addVoiceprint(root,'李四',new Float32Array([1,0]),source);
  assert.deepEqual(readVoiceBook(root).map(person=>person.name),['李四'],'correcting a source must remove its old wrong template');
});

test('legacy templates migrate with a stable identity and the three-template bound',()=>{
  root=mkdtempSync(join(tmpdir(),'earshot-book-migrate-'));const path=join(root,'people-voice.json');
  const encoded=n=>Buffer.from(new Float32Array([n,1]).buffer).toString('base64');
  writeFileSync(path,JSON.stringify({people:{'张三':[encoded(1),encoded(2)]}}));
  const id=readVoiceBook(root)[0].id;addVoiceprint(root,'张三',new Float32Array([3,1]));
  addVoiceprint(root,'张三',new Float32Array([4,1]));
  assert.equal(readVoiceBook(root)[0].id,id);assert.deepEqual(readVoiceBook(root)[0].embeddings.map(v=>v[0]),[2,3,4]);
  assert.equal(JSON.parse(readFileSync(path,'utf8')).schema_version,2);
});

test('model and source provenance are persisted and foreign model templates cannot match',async()=>{
  const {VOICEPRINT_MODEL}=await import('./paths.ts');
  root=mkdtempSync(join(tmpdir(),'earshot-book-model-'));const path=join(root,'people-voice.json');
  const source={sessionId:'fixture-session',artifact:'speakers-v1.json',cluster:'A',audioKey:'a'.repeat(64),track:'other',segments:[{startMs:0,endMs:4000}]};
  addVoiceprint(root,'张三',new Float32Array([1,0]),source);
  const raw=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(raw.people[0].templates[0].model,VOICEPRINT_MODEL);assert.deepEqual(raw.people[0].templates[0].source,source);
  raw.people[0].templates.push({model:'another-model.onnx',embedding:Buffer.from(new Float32Array([0,1]).buffer).toString('base64')});
  writeFileSync(path,JSON.stringify(raw));assert.deepEqual(readVoiceBook(root)[0].embeddings.map(v=>Array.from(v)),[[1,0]]);
});
