import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from './sessions.ts';
import { exportTranscript } from '../export.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'earshot-title-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  return { root, store: createSessionStore(root) };
}

test('new recording titles contain their own local date and start time without renaming older sessions', t => {
  const {store} = fixture(t);
  t.mock.timers.enable({apis:['Date'], now:new Date(2026,8,7,9,30).getTime()});
  const first = store.createRecording();
  assert.equal(first.title, '9月7日 09:30 的录音');
  store.writeSession({...first,title:'已有自定义名称'});
  t.mock.timers.tick(60_000);
  const second = store.createRecording();
  assert.equal(second.title, '9月7日 09:31 的录音');
  assert.equal(store.readSession(first.id).title, '已有自定义名称');
});

test('rename trims, persists and invalidates list/detail caches; reopening and export use the new title', async t => {
  const {root,store} = fixture(t);
  const doc=store.createRecording();
  store.finalize(doc.id,'complete');
  writeFileSync(join(store.sessionDir(doc.id),'live.jsonl'),JSON.stringify({id:'one',track:'you',tStartMs:1200,text:'fixture text'})+'\n');
  store.listSummaries();store.getDetail(doc.id);
  assert.deepEqual(store.renameSession({sessionId:doc.id,title:'  周一 / 产品同步  '}),{ok:true});
  assert.equal(store.listSummaries()[0].title,'周一 / 产品同步');
  assert.equal(store.getDetail(doc.id).title,'周一 / 产品同步');
  const reopened=createSessionStore(root);
  assert.equal(reopened.getDetail(doc.id).title,'周一 / 产品同步');
  let name;
  const exported=mkdtempSync(join(tmpdir(),'earshot-export-title-'));
  t.after(()=>rmSync(exported,{recursive:true,force:true}));
  const path=join(exported,'export.json');
  assert.deepEqual(await exportTranscript(reopened,{sessionId:doc.id,format:'json'},async filename=>{name=filename;return path;}),{ok:true,canceled:false});
  assert.equal(name,'周一 产品同步.json');
  assert.equal(JSON.parse(readFileSync(path,'utf8')).session.title,'周一 / 产品同步');
});

test('invalid names and identifiers are rejected without changing the stored session', t => {
  const {store}=fixture(t), doc=store.createRecording();
  const before=JSON.stringify(store.readSession(doc.id));
  for(const input of [null,[],{},{sessionId:'../outside',title:'bad'},
    ...['','  ','x'.repeat(81),'hello\nworld',123,{}].map(title=>({sessionId:doc.id,title}))]) {
    assert.equal(store.renameSession(input).ok,false,JSON.stringify(input));
    assert.equal(JSON.stringify(store.readSession(doc.id)),before);
  }
  assert.equal(store.renameSession({sessionId:doc.id,title:'字'.repeat(80)}).ok,true);
  assert.equal(store.renameSession({sessionId:doc.id,title:'😀'.repeat(80)}).ok,true);
  assert.equal(store.renameSession({sessionId:doc.id,title:'😀'.repeat(81)}).ok,false);
});

test('failed rename leaves the original session readable and allows a later retry', t => {
  const {store}=fixture(t),doc=store.createRecording();
  const dir=store.sessionDir(doc.id),path=join(dir,'session.json');
  const before=readFileSync(path,'utf8');
  chmodSync(dir,0o500);
  try { assert.equal(store.renameSession({sessionId:doc.id,title:'新标题'}).ok,false); }
  finally { chmodSync(dir,0o700); }
  assert.equal(readFileSync(path,'utf8'),before);
  assert.equal(store.renameSession({sessionId:doc.id,title:'新标题'}).ok,true);
  assert.equal(store.readSession(doc.id).title,'新标题');
});
