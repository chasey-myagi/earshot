import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from './sessions.ts';
import { exportTranscript } from '../export.ts';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'earshot-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(root), doc = store.createRecording();
  store.finalize(doc.id, 'complete', { durationSec: 30 });
  const turns = [
    { id: 'a', track: 'other', speaker: '小 A', tStartMs: 1000, tEndMs: 4000, text: '今天讨论 MatrixOne 合同。' },
    { id: 'b', track: 'other', speaker: '小 A', tStartMs: 6000, tEndMs: 9000, text: '预算还需要核对。' },
    { id: 'c', track: 'you', speaker: '你', tStartMs: 10000, text: '共享麦克风里有其他同事。' },
  ];
  const source = join(store.sessionDir(doc.id), 'refined-v1.json');
  writeFileSync(source, JSON.stringify({ turns }));
  store.patchJobs(doc.id, { refined: { status: 'done', current: 'refined-v1.json' } });
  const input = (id = 'a', extra = {}) => ({ sessionId: doc.id, turnId: id, revision: store.getDetail(doc.id).turns.find(t => t.id === id).correction.revision, ...extra });
  return { root, store, doc, turns, source, input };
}

test('per-turn correction persists original source, timestamps and undo across restart without registering people', async t => {
  const { root, store, doc, source, input } = fixture(t), before = readFileSync(source, 'utf8');
  assert.deepEqual(store.correctTurn(input('a', { text: '今天讨论 MatrixOne 正式合同。', speaker: '王明' })), { ok: true });
  const reopened = createSessionStore(root), detail = reopened.getDetail(doc.id);
  assert.equal(detail.turns[0].speaker, '王明');
  assert.equal(detail.turns[1].speaker, '小 A');
  assert.equal(detail.turns[0].tStartMs, 1000); assert.equal(detail.turns[0].tEndMs, 4000);
  assert.equal(detail.turns[0].correction.originalText, '今天讨论 MatrixOne 合同。');
  assert.equal(detail.turns[0].correction.originalSpeaker, '小 A');
  assert.equal(readFileSync(source, 'utf8'), before);
  assert.deepEqual(reopened.readPeople(), []); assert.equal(existsSync(join(root, 'people.json')), false);
  assert.equal(statSync(join(store.sessionDir(doc.id), 'corrections.json')).mode & 0o777, 0o600);
  const exported = mkdtempSync(join(tmpdir(), 'earshot-tools-export-'));
  t.after(() => rmSync(exported, { recursive:true, force:true }));
  const path = join(exported, 'corrected.json');
  assert.equal((await exportTranscript(reopened, { sessionId: doc.id, format: 'json' }, async () => path)).ok, true);
  const exportedTurn = JSON.parse(readFileSync(path, 'utf8')).turns[0];
  assert.equal(exportedTurn.speaker, '王明'); assert.equal(exportedTurn.text, detail.turns[0].text);
  assert.equal(reopened.undoTurnCorrection({ sessionId:doc.id, turnId:'a', revision:detail.turns[0].correction.revision }).ok,true);
  assert.equal(createSessionStore(root).getDetail(doc.id).turns[0].text, '今天讨论 MatrixOne 合同。');
});

test('stale editor and regenerated same turn id are rejected, old modifications remain archived and visible as a warning', t => {
  const { store, doc, source, input, turns } = fixture(t);
  const stale = input('a', { text:'旧编辑器', speaker:'王明' });
  assert.equal(store.correctTurn(input('a', { text:'正确文本', speaker:'王明' })).ok,true);
  assert.equal(store.correctTurn(stale).ok,false);
  const edited = input('a', { text:'不该套用', speaker:'王明' });
  writeFileSync(source,JSON.stringify({turns:turns.map(turn => turn.id==='a'?{...turn,text:'后台重新生成'}:turn)}));
  assert.equal(store.correctTurn(edited).ok,false);
  const updated=store.getDetail(doc.id);
  assert.equal(updated.turns[0].text,'后台重新生成');
  assert.match(updated.transcriptToolsError,/旧稿修改/);
  const records=JSON.parse(readFileSync(join(store.sessionDir(doc.id),'corrections.json'),'utf8')).records;
  assert.equal(Object.values(records)[0].source.turn.text,turns[0].text);
  assert.equal(Object.values(records)[0].value.text,'正确文本');
  assert.equal(store.correctTurn(input('a',{text:'新稿修正',speaker:'小 A'})).ok,true);
  store.patchJobs(doc.id,{refined:{current:'refined-v2.json'}});
  writeFileSync(join(store.sessionDir(doc.id),'refined-v2.json'),JSON.stringify({turns}));
  assert.equal(store.getDetail(doc.id).turns[0].text,turns[0].text);
});

test('cluster rename preserves a manual override but invalidates open editors; reset and undo remain available', t => {
  const {store,doc,input}=fixture(t);
  assert.equal(store.correctTurn(input('a',{text:'人工纠错',speaker:'王明'})).ok,true);
  const stale=input('b',{text:'另一个段落',speaker:'小 A'});
  store.writeNames(doc.id,{'小 A':'李华'});
  assert.equal(store.getDetail(doc.id).turns[0].speaker,'王明');
  assert.equal(store.getDetail(doc.id).turns[1].speaker,'李华');
  assert.equal(store.correctTurn(stale).ok,false);
  assert.equal(store.resetTurnCorrection(input()).ok,true);
  assert.equal(store.getDetail(doc.id).turns[0].speaker,'李华');
  assert.equal(store.undoTurnCorrection(input()).ok,true);
  assert.equal(store.getDetail(doc.id).turns[0].speaker,'王明');
  assert.equal(store.correctTurn(input('c',{text:'共享麦克风里有其他同事。',speaker:'赵敏'})).ok,true);
  assert.equal(store.getDetail(doc.id).turns[2].correction.speakerOverridden,true);
});

test('local literal search combines Chinese, mixed-case terms and speaker/title, follows edits renames and removal', t => {
  const { store, doc, input }=fixture(t);
  store.renameSession({sessionId:doc.id,title:'项目同步'});
  assert.equal(store.searchTranscripts({query:'项目 matrixONE 合同'}).hits[0].turnId,'a');
  assert.equal(store.searchTranscripts({query:'项目同步'}).hits.length,1);
  assert.equal(store.searchTranscripts({query:'[.*'}).hits.length,0);
  store.correctTurn(input('a',{text:'延期付款',speaker:'王明'}));
  assert.equal(store.searchTranscripts({query:'MatrixOne'}).hits.length,0);
  assert.equal(store.searchTranscripts({query:'王明 延期'}).hits[0].tStartMs,1000);
  store.writeNames(doc.id,{'小 A':'李华'});
  assert.equal(store.searchTranscripts({query:'李华 预算'}).hits[0].turnId,'b');
  store.renameSession({sessionId:doc.id,title:'新项目'});
  assert.equal(store.searchTranscripts({query:'项目同步'}).hits.length,0);
  const limited=store.searchTranscripts({query:'新项目',limit:1});
  assert.equal(limited.hits.length,1);assert.equal(limited.truncated,false);
  rmSync(store.sessionDir(doc.id),{recursive:true,force:true});
  store.invalidate(doc.id);
  assert.equal(store.searchTranscripts({query:'延期'}).hits.length,0);
});

test('search cap and bounded excerpts cover long transcripts without interpreting patterns',t=>{
  const {store,doc,source,turns}=fixture(t);
  writeFileSync(source,JSON.stringify({turns:Array.from({length:8},(_,i)=>({...turns[0],id:`turn-${i}`,text:'前'.repeat(300)+' literal.* 搜索 '+ '后'.repeat(300)}))}));
  const result=store.searchTranscripts({query:'literal.* 搜索',limit:3});
  assert.equal(result.hits.length,3);assert.equal(result.truncated,true);
  for(const hit of result.hits){assert.ok(hit.snippet.length<=182);assert.match(hit.snippet,/literal\.\*/);}
  for(const raw of [null,[],{query:12},{query:'a'.repeat(201)},{query:'a',limit:0},{query:'a',limit:101}]) assert.equal(store.searchTranscripts(raw).ok,false);
});

test('bookmarks persist privately, sort by audio time, allow live/replay and reject outside duration or dictation',t=>{
  const {root,store,doc}=fixture(t);
  assert.equal(store.addBookmark({sessionId:doc.id,tStartMs:12000,label:'  预算  '}).ok,true);
  assert.equal(store.addBookmark({sessionId:doc.id,tStartMs:2000}).ok,true);
  const reopened=createSessionStore(root), marks=reopened.getDetail(doc.id).bookmarks;
  assert.deepEqual(marks.map(mark=>mark.tStartMs),[2000,12000]);assert.equal(marks[1].label,'预算');
  assert.equal(statSync(join(store.sessionDir(doc.id),'bookmarks.json')).mode&0o777,0o600);
  assert.equal(reopened.deleteBookmark({sessionId:doc.id,bookmarkId:marks[0].id}).ok,true);
  assert.equal(createSessionStore(root).getDetail(doc.id).bookmarks.length,1);
  for(const tStartMs of [-1,30001,1.5,Infinity,NaN,'100']) assert.equal(store.addBookmark({sessionId:doc.id,tStartMs}).ok,false);
  assert.equal(store.addBookmark({sessionId:doc.id,tStartMs:0,label:'x'.repeat(81)}).ok,false);
  const live=store.createRecording();
  assert.equal(store.addBookmark({sessionId:live.id,tStartMs:0,label:'开场'}).ok,true);
  assert.equal(store.addBookmark({sessionId:live.id,tStartMs:60_000}).ok,false);
  const dictationId='deafbeef-1234-1234-1234-123456789abc';
  store.saveDictation({id:dictationId,startedAt:Date.now(),durationSec:1,result:{text:'你好',rawText:'你好',asrModel:'test'}});
  assert.equal(store.addBookmark({sessionId:dictationId,tStartMs:0}).ok,false);
});

test('invalid IDs, corrupt data and write failures cannot overwrite source or previous tool files',t=>{
  const {store,doc,input}=fixture(t),dir=store.sessionDir(doc.id);
  for(const sessionId of ['../outside','','x/y',null]) {
    assert.equal(store.correctTurn({...input(),sessionId,text:'新',speaker:'王'}).ok,false);
    assert.equal(store.addBookmark({sessionId,tStartMs:0}).ok,false);
  }
  const pending=input('a',{text:'新',speaker:'王'});
  const corrupt='{broken';
  for(const file of ['corrections.json','bookmarks.json']) writeFileSync(join(dir,file),corrupt);
  assert.equal(store.correctTurn(pending).ok,false);
  assert.equal(store.addBookmark({sessionId:doc.id,tStartMs:0}).ok,false);
  for(const file of ['corrections.json','bookmarks.json']) assert.equal(readFileSync(join(dir,file),'utf8'),corrupt);
  assert.match(store.getDetail(doc.id).transcriptToolsError,/无法读取/);
  rmSync(join(dir,'corrections.json'));
  store.invalidate(doc.id);
  assert.equal(store.correctTurn(input('a',{text:'可保存',speaker:'王'})).ok,true);
  const path=join(dir,'corrections.json'),before=readFileSync(path,'utf8');
  chmodSync(path,0o400);
  try{assert.equal(store.correctTurn(input('a',{text:'写失败',speaker:'王'})).ok,false);}
  finally{chmodSync(path,0o600);}
  assert.equal(readFileSync(path,'utf8'),before);
});

test('dictation correction changes read/export/search text but preserves raw transcript and source document',async t=>{
  const {root,store}=fixture(t), id='abcdefab-1234-1234-1234-123456789abc';
  store.saveDictation({id,startedAt:Date.now(),durationSec:2,result:{text:'原始润色结果',rawText:'原始口述',asrModel:'test'}});
  const path=join(store.sessionDir(id),'session.json'),before=readFileSync(path,'utf8');
  const current=store.getDetail(id).turns[0];
  assert.equal(store.correctTurn({sessionId:id,turnId:'dictation',revision:current.correction.revision,text:'已修正的语音输入',speaker:'你'}).ok,true);
  const detail=createSessionStore(root).getDetail(id);
  assert.equal(detail.dictation.text,'已修正的语音输入');assert.equal(detail.dictation.rawText,'原始口述');
  assert.equal(readFileSync(path,'utf8'),before);
  assert.equal(store.searchTranscripts({query:'已修正的语音输入'}).hits[0].sessionId,id);
});

test('a revision from an identical-looking different session cannot authorize a correction',t=>{
  const {store,doc,source,input}=fixture(t),other=store.createRecording();
  store.finalize(other.id,'complete',{durationSec:30});
  writeFileSync(join(store.sessionDir(other.id),'refined-v1.json'),readFileSync(source));
  store.patchJobs(other.id,{refined:{status:'done',current:'refined-v1.json'}});
  const raw=input('a',{text:'错会话',speaker:'小 A'});
  assert.equal(store.correctTurn({...raw,sessionId:other.id}).ok,false);
  assert.notEqual(store.getDetail(doc.id).turns[0].correction.revision,store.getDetail(other.id).turns[0].correction.revision);
});

test('TXT and JSON export preserve a manual speaker correction on the microphone track',async t=>{
  const {store,doc,input}=fixture(t);
  assert.equal(store.correctTurn(input('c',{text:'共享麦克风确认的发言。',speaker:'赵敏'})).ok,true);
  const dir=mkdtempSync(join(tmpdir(),'earshot-speaker-export-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const format of ['txt','json']){
    const path=join(dir,`out.${format}`);
    assert.equal((await exportTranscript(store,{sessionId:doc.id,format},async()=>path)).ok,true);
    const saved=readFileSync(path,'utf8');
    if(format==='json')assert.equal(JSON.parse(saved).turns.find(turn=>turn.id==='c').speaker,'赵敏');
    else assert.match(saved,/赵敏：共享麦克风确认的发言。/);
  }
});
