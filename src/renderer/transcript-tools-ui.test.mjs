import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const api=new Proxy({}, {get:()=>async()=>({ok:true})});
const source=readFileSync(new URL('./Library.tsx',import.meta.url),'utf8');
const code=buildSync({stdin:{contents:source+'\nexport { DictationDetail, SettingsPane };\nexport { Turns } from "./Turns";\nexport { Bookmarks } from "./Bookmarks";\nexport { TranscriptEditor } from "./TranscriptEditor";',resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react-dom'],loader:{'.png':'dataurl','.css':'empty'}}).outputFiles[0].text;
const mod={exports:{}};
runInNewContext(code,{module:mod,exports:mod.exports,require:createRequire(import.meta.url),console,window:{earshot:api}});
const render=(name,props)=>renderToStaticMarkup(createElement(mod.exports[name],props));
const turn={id:'one',track:'you',speaker:'赵敏',text:'修正后的正文',tStartMs:12000,correction:{revision:'1'.repeat(64),originalText:'原来的正文',originalSpeaker:'你',edited:true,speakerOverridden:true,canUndo:true}};
const detail={id:'session-1',title:'项目会议',startedAt:'2026-09-08T00:00:00Z',endedAt:'2026-09-08T00:01:00Z',durationSec:60,status:'complete',jobs:{live:'done',refined:'done',speakers:'done'},turns:[turn],people:[]};
const snap={hasApiKey:true,autoDiarize:true,permissions:{microphone:'granted',screen:'granted'},recording:null,playingSessionId:null,sessions:[detail],selectedId:detail.id,selected:detail};

test('actual turn markup distinguishes manual single-turn speaker correction from cluster rename',()=>{
  const html=render('Turns',{turns:[turn],sessionId:detail.id,editable:true,variant:'library',onRename(){}});
  assert.match(html,/赵敏/);assert.match(html,/修改 00:12 这一段/);assert.match(html,/已修改 · 编辑/);
  assert.doesNotMatch(html,/修改这位说话人的整组发言名称/);
  const grouped=render('Turns',{turns:[{...turn,track:'other',speaker:'王明',correction:{...turn.correction,speakerOverridden:false}}],sessionId:detail.id,editable:true,variant:'library',onRename(){}});
  assert.match(grouped,/整组改名/);assert.match(grouped,/修改 00:12 这一段/);
});

test('actual editor provides labelled text/speaker fields, persisted undo and original source disclosure',()=>{
  const html=render('TranscriptEditor',{sessionId:detail.id,turn,onSave:api.correctTurn,onUndo:api.undoTurnCorrection,onReset:api.resetTurnCorrection,onClose(){}});
  for(const label of ['这一段的说话人','正文','撤销上次修改','恢复原稿','保存修改','查看原始转写','原来的正文'])assert.ok(html.includes(label),label);
  assert.match(html,/textarea/);assert.match(html,/说话人姓名不会登记为声纹/);
});

test('recording bookmarks show accessible add/seek/delete actions and actual time',()=>{
  const html=render('Bookmarks',{sessionId:detail.id,positionMs:12345,items:[{id:'mark-1',tStartMs:12000,label:'合同确认'}],onAdd:api.addBookmark,onDelete:api.deleteBookmark,onSeek(){}});
  assert.match(html,/标记 00:12/);assert.match(html,/回听标记 合同确认，00:12/);assert.match(html,/删除标记 合同确认/);
});

test('library exposes local search and import with a cancelable progress state that blocks starting',()=>{
  const html=render('Library',{snap,refresh:async()=>{}});
  assert.match(html,/搜索标题、正文或说话人/);assert.match(html,/导入录音/);
  const importing=render('Library',{snap:{...snap,audioImport:{phase:'decoding',percent:35,message:'正在读取录音'}},refresh:async()=>{}});
  assert.match(importing,/正在读取录音/);assert.match(importing,/取消导入/);assert.match(importing,/aria-label="录音导入进度"/);
  assert.match(importing,/<button[^>]*disabled=""[^>]*>开始录制<\/button>/);
});

test('corrected dictation retains raw disclosure and edit action in the real detail',()=>{
  const html=render('DictationDetail',{detail:{...detail,kind:'dictation',dictation:{text:turn.text,rawText:'最初口述',asrModel:'test'}},editingBlocked:false,actionError:null});
  assert.match(html,/修改文字/);assert.match(html,/修正后的正文/);assert.match(html,/最初口述/);assert.match(html,/已手动修改/);
});

test('settings includes hotwords and local usage sections alongside existing permissions',()=>{
  const html=render('SettingsPane',{snap,keyDraft:'',keyError:null,keyBusy:false,keySaved:false,asking:null,onKeyDraft(){},onKeySave(){},onAsk(){}});
  for(const label of ['个人热词','用量与费用','查看百炼账单','系统权限'])assert.ok(html.includes(label),label);
});
