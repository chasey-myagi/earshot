// Isolated real React Library UI. The synthetic bridge never touches production
// sessions, the main process, account keys, audio, macOS permissions or the cloud.
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const temp = mkdtempSync(join(tmpdir(), 'earshot-session-selection-ui-'));
const evidence = resolve(process.env.EARSHOT_UI_EVIDENCE ?? '../earshot-release-evidence/2026-09-09-settings-sessions', `session-selection-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(evidence, { recursive: true });
const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Library} from ${JSON.stringify(resolve('src/renderer/Library.tsx'))};
import ${JSON.stringify(resolve('src/renderer/styles.css'))};
const today=new Date();today.setHours(10,0,0,0);
const dayBefore=days=>new Date(today.getTime()-days*86400000).toISOString();
const make=(id,title,kind,days=0,status='complete')=>({id,title,kind,startedAt:dayBefore(days),endedAt:dayBefore(days),durationSec:kind==='dictation'?29:1800,status,
  jobs:{live:'done',refined:'done',speakers:'done'},people:[],bookmarks:[],
  turns:[{id:'turn-'+id,track:'you',speaker:'你',text:'请确认下一次的时间。',tStartMs:0}],
  ...(kind==='dictation'?{dictation:{text:'请确认下一次的时间。',rawText:'请确认下一次的时间。',asrModel:'fixture-model'}}:{})});
const seed=[make('recording-today','今天的产品评审','recording'),make('dictation-today','今天的语音输入','dictation'),
  make('recording-yesterday','昨天的设计讨论','recording',1),make('dictation-yesterday','昨天的语音输入','dictation',1),
  make('recording-earlier','上周的项目回顾','recording',7),make('protected-recording','尚未结束的录制','recording',8,'recording')];
const initial=()=>({hasApiKey:true,autoDiarize:true,permissions:{microphone:'granted',screen:'granted'},recording:null,capturePhase:'idle',playingSessionId:null,
  sessions:seed.map(row=>({...row})),selectedId:seed[0].id,selected:{...seed[0]},deletions:[]});
let state,update,generation=0,delaySelections=false;
const deleteCalls=[],renameCalls=[],undoCalls=[],pendingDeletes=[],pendingSelections=[],deleted=new Map();
function select(id){update(current=>({...current,selectedId:id,selected:current.sessions.find(row=>row.id===id)??null}));}
window.earshot={
  searchTranscripts:async()=>({ok:true,hits:[],truncated:false}),onChange:()=>()=>{},selectSession:id=>delaySelections?new Promise(resolve=>pendingSelections.push({id,resolve})):Promise.resolve(select(id)),
  setShortcutCapture:async()=>({ok:true}),
  hotwordStatus:async()=>({words:[],updatedAt:null,sync:'empty',models:[]}),
  usageSummary:async period=>({period,since:today.getTime(),updatedAt:today.getTime(),trackingSince:today.getTime(),requests:0,audioSeconds:0,inputTokens:0,outputTokens:0,estimatedCny:0,unpricedRequests:0,localMeasuredRequests:0,unconfirmedRequests:0,rows:[],actualBilling:'unavailable',balanceCny:null,billingReason:'Fixture',pricingDate:'2026-09-09',retentionDays:90,capped:false}),
  renameSession:async input=>{renameCalls.push(input);update(current=>{const sessions=current.sessions.map(row=>row.id===input.sessionId?{...row,title:input.title}:row);return {...current,sessions,selected:sessions.find(row=>row.id===current.selectedId)??null};});return {ok:true};},
  deleteSession:id=>{deleteCalls.push(id);return new Promise(resolve=>pendingDeletes.push({id,resolve}));},
  undoDeleteSession:async id=>{undoCalls.push(id);const restored=deleted.get(id);if(!restored)return {ok:false,error:'Fixture: unknown deleted session'};
    update(current=>({...current,sessions:[...current.sessions,restored].sort((a,b)=>seed.findIndex(row=>row.id===a.id)-seed.findIndex(row=>row.id===b.id)),deletions:current.deletions.filter(row=>row.sessionId!==id)}));deleted.delete(id);return {ok:true};}
};
window.qa={deleteCalls,renameCalls,undoCalls,pendingDeletes,pendingSelections,select,get state(){return state;},
  navigate(id){update(current=>({...current,selectedId:id,selected:current.sessions.find(row=>row.id===id)??null,libraryRequest:(current.libraryRequest??0)+1}));},
  addUnselectedDictation(){update(current=>({...current,sessions:[{...seed.find(row=>row.id==='dictation-today')}]}));},
  delaySelections(){delaySelections=true;},
  resolveSelection(index=0){const request=pendingSelections.splice(index,1)[0];if(!request)throw Error('No pending selection');select(request.id);request.resolve();},
  reset(empty=false){if(pendingDeletes.length||pendingSelections.length)throw Error('Cannot reset with pending requests');deleteCalls.length=renameCalls.length=undoCalls.length=0;deleted.clear();delaySelections=false;generation++;const next=initial();update(empty?{...next,sessions:[],selectedId:null,selected:null}:next);},
  resolveDelete(result={ok:true}){const request=pendingDeletes.shift();if(!request)throw Error('No pending deletion');
    if(result.ok){const original=state.sessions.find(row=>row.id===request.id);if(!original)throw Error('Deleting absent fixture session');if(original.status==='recording')throw Error('Attempt to delete a protected recording');deleted.set(request.id,original);
      update(current=>{const sessions=current.sessions.filter(row=>row.id!==request.id),selectedId=current.selectedId===request.id?(sessions[0]?.id??null):current.selectedId;
        return {...current,sessions,selectedId,selected:sessions.find(row=>row.id===selectedId)??null,deletions:[...current.deletions,{sessionId:original.id,title:original.title,expiresAt:Date.now()+8000}]};});}
    request.resolve(result);
  }
};
function App(){[state,update]=useState(initial);return <Library key={generation} snap={state} refresh={async()=>{}}/>;}
createRoot(document.getElementById('root')).render(<App/>);
`;
await build({ stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: 'session-selection-fixture.jsx', loader: 'jsx' }, outfile: join(temp, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' } });
writeFileSync(join(temp, 'index.html'), `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>`);

async function runElectron(config) {
  const { app, BrowserWindow, session, nativeTheme } = await import('electron');
  const { join } = await import('node:path');
  const { writeFileSync } = await import('node:fs');
  const assert = (await import('node:assert/strict')).default;
  app.setPath('userData', join(config.temp, 'profile'));
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const results = [], screenshots = [];
  let win;
  const check = (value, label) => { assert.ok(value, label); results.push({ pass: true, assertion: label }); };
  try {
    const isolated = session.fromPartition('session-selection-qa');
    isolated.setPermissionRequestHandler((_window, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file://' + config.temp + '/') }));
    win = new BrowserWindow({ show: false, width: 1180, height: 820, webPreferences: { session: isolated, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadFile(join(config.temp, 'index.html'));
    const run = code => win.webContents.executeJavaScript(code, true);
    const pause = () => new Promise(resolve => setTimeout(resolve, 60));
    const until = async code => { for (let i = 0; i < 100; i++) { if (await run(code)) return; await pause(); } throw Error('Wait expired: ' + code); };
    const row = id => `.session-row[data-session-id="${id}"]`;
    const selection = async () => run(`Array.from(document.querySelectorAll('.session-row.selected')).map(el=>el.dataset.sessionId).sort()`);
    const expectSelection = async (ids, label) => { const actual = await selection(); assert.deepEqual(actual, [...ids].sort(), label); check(await run(`Array.from(document.querySelectorAll('.session-row > .sl-row')).every(el=>(el.getAttribute('aria-pressed')==='true')===el.parentElement.classList.contains('selected'))`), label + '; visual and accessible selection agree'); };
    const click = async (selector, text) => {
      await run(`(()=>{const nodes=Array.from(document.querySelectorAll(${JSON.stringify(selector)}));const el=${text ? `nodes.find(el=>el.textContent.trim()===${JSON.stringify(text)})` : 'nodes[0]'};if(!el)throw Error('Missing click target: '+${JSON.stringify(selector)});el.click();})()`);
      await pause();
    };
    const clickRow = async (id, modifiers = {}) => {
      await run(`(()=>{const el=document.querySelector(${JSON.stringify(row(id) + ' > .sl-row')});if(!el)throw Error('Missing row: '+${JSON.stringify(id)});el.focus();el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1,...${JSON.stringify(modifiers)}}));})()`);
      await pause();
    };
    const doubleRow = async id => {
      await clickRow(id);
      await run(`(()=>{const el=document.querySelector(${JSON.stringify(row(id) + ' > .sl-row')});el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:2}));el.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,detail:2}));})()`);
      await until(`Boolean(document.querySelector(${JSON.stringify(row(id) + ' input')}))`);
    };
    const context = async id => { await run(`document.querySelector(${JSON.stringify(row(id))}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:200}))`); await until(`Boolean(document.querySelector('.session-menu'))`); };
    const keyboard = async (selector, key, modifiers = {}) => { await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing keyboard target: '+${JSON.stringify(selector)});el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true,...${JSON.stringify(modifiers)}}));})()`); await pause(); };
    const input = async (selector, value) => { await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`); await pause(); };
    const reset = async () => { await run('qa.reset()'); await until(`document.querySelectorAll('.session-row').length===6&&!document.querySelector('.session-menu')`); await pause(); };
    const filter = async label => click('.session-filter button', label);
    const finishDelete = async (result = { ok: true }) => { await until('qa.pendingDeletes.length===1'); await run(`qa.resolveDelete(${JSON.stringify(result)})`); await pause(); };
    const screenshot = async name => { await pause(); const path = join(config.evidence, name + '.png'); writeFileSync(path, (await win.webContents.capturePage()).toPNG()); screenshots.push(path); };

    await until(`document.querySelectorAll('.session-row').length===6`);
    await run('qa.reset(true)');
    await until(`document.querySelectorAll('.session-row').length===0`);
    await run('qa.delaySelections();qa.addUnselectedDictation()');
    await until(`document.querySelectorAll('.session-row').length===1&&qa.pendingSelections.length===1`);
    check(await run(`qa.state.selectedId===null&&qa.pendingSelections[0].id==='dictation-today'`), 'the first dictation in an empty library triggers the real Library fallback selection request');
    await run('qa.resolveSelection()');
    await until(`qa.state.selectedId==='dictation-today'&&document.querySelector('.session-title h2')?.textContent==='今天的语音输入'`);
    await pause();
    const emptyLibrarySelection = { selectedId: await run('qa.state.selectedId'), expectedSelection: ['dictation-today'], actualSelection: await selection() };
    writeFileSync(join(config.evidence, 'empty-library-selection.json'), JSON.stringify(emptyLibrarySelection, null, 2));
    await expectSelection(['dictation-today'], 'the first dictation becomes selected after the Library fallback request is acknowledged');
    await reset();
    check(await run(`Array.from(document.querySelectorAll('.sl-group')).map(el=>el.textContent).join(',')==='今天,更早'`), 'mixed recording and dictation fixture spans today and earlier groups');
    await clickRow('recording-today');
    await clickRow('dictation-yesterday', { metaKey: true });
    await expectSelection(['recording-today', 'dictation-yesterday'], 'Command click adds a session of the other kind');
    check(await run(`document.querySelector('.session-selection-bar').textContent.includes('2')`), 'selection bar states the number of selected sessions');
    await clickRow('recording-today', { metaKey: true });
    await expectSelection(['dictation-yesterday'], 'Command click removes an already selected session');
    await clickRow('recording-today');
    await clickRow('dictation-yesterday', { shiftKey: true });
    await expectSelection(['recording-today', 'dictation-today', 'recording-yesterday', 'dictation-yesterday'], 'Shift selects a contiguous range across day groups');
    await clickRow('recording-earlier');
    await clickRow('dictation-today', { shiftKey: true });
    await expectSelection(['dictation-today', 'recording-yesterday', 'dictation-yesterday', 'recording-earlier'], 'Shift range works in reverse visual order');
    await clickRow('recording-today');
    await clickRow('dictation-yesterday', { metaKey: true });
    await clickRow('recording-earlier', { metaKey: true, shiftKey: true });
    await expectSelection(['recording-today', 'dictation-yesterday', 'recording-earlier'], 'Command Shift extends a range while retaining a noncontiguous selection');
    await clickRow('dictation-today');
    await expectSelection(['dictation-today'], 'ordinary click resets a multiple selection');

    await clickRow('recording-today', { metaKey: true });
    await context('dictation-today');
    await expectSelection(['recording-today', 'dictation-today'], 'right click on a selected member preserves the complete selection');
    check(await run(`(()=>{const items=Array.from(document.querySelectorAll('.session-menu [role=menuitem]'));return items.length===1&&items[0].textContent.includes('删除')&&!document.querySelector('.session-menu').textContent.match(/改名|访达/);})()`), 'context menu exposes deletion only, with no rename or Finder action');
    await keyboard('.session-menu button', 'Escape');
    check(await run(`!document.querySelector('.session-menu')`), 'Escape dismisses the open session context menu');
    await expectSelection(['recording-today', 'dictation-today'], 'Escape in the portaled context menu preserves the selected sessions');
    await context('recording-earlier');
    await expectSelection(['recording-earlier'], 'right click on an unselected member replaces the previous selection');
    await keyboard('.session-menu button', 'Escape');

    await reset();
    await clickRow('recording-today');
    await clickRow('dictation-today', { metaKey: true });
    await context('dictation-today');
    await run(`(()=>{const el=document.querySelector(${JSON.stringify(row('dictation-today') + ' > .sl-row')});el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'mouse',button:0}));el.focus();el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1,button:0}));})()`);
    await pause();
    const pointerReselection = { menuRemains: await run(`Boolean(document.querySelector('.session-menu'))`), expectedSelection: ['dictation-today'], actualSelection: await selection() };
    if (!pointerReselection.menuRemains) await context('dictation-today');
    await click('.session-menu button');
    await until('qa.pendingDeletes.length===1');
    for (let i = 0; i < 6 && await run('qa.pendingDeletes.length>0'); i++) await finishDelete();
    pointerReselection.expectedDeleteCalls = ['dictation-today'];
    pointerReselection.actualDeleteCalls = await run('[...qa.deleteCalls]');
    writeFileSync(join(config.evidence, 'context-pointer-reselection.json'), JSON.stringify(pointerReselection, null, 2));
    check(!pointerReselection.menuRemains, 'pointer clicking the current row outside its context menu dismisses the menu');
    assert.deepEqual(pointerReselection.actualSelection, pointerReselection.expectedSelection, 'ordinary pointer click replaces the context-menu multiple selection');
    check(true, 'ordinary pointer click selects only its row after dismissing the context menu');
    assert.deepEqual(pointerReselection.actualDeleteCalls, pointerReselection.expectedDeleteCalls, 'deletion after pointer reselection cannot reuse the old multiple-selection targets');
    check(true, 'deletion after pointer reselection targets only the currently selected row');
    await reset();

    await clickRow('recording-today');
    await clickRow('dictation-today', { metaKey: true });
    await context('dictation-today');
    await click('.session-menu button');
    await finishDelete();
    await finishDelete();
    check(await run(`JSON.stringify(qa.deleteCalls)===JSON.stringify(['recording-today','dictation-today'])&&qa.state.sessions.length===4`), 'context-menu Delete removes exactly the selected recording and dictation sessions');
    await reset();
    await clickRow('recording-today');
    await clickRow('dictation-today', { metaKey: true });
    await context('recording-earlier');
    await click('.session-menu button');
    await finishDelete();
    check(await run(`JSON.stringify(qa.deleteCalls)===JSON.stringify(['recording-earlier'])&&qa.state.sessions.some(row=>row.id==='recording-today')&&qa.state.sessions.some(row=>row.id==='dictation-today')`), 'context-menu Delete on an unselected row does not delete the previous selection');
    await reset();

    await clickRow('recording-today');
    await clickRow('dictation-yesterday', { metaKey: true });
    await filter('输入');
    check(await run(`document.querySelectorAll('.session-row').length===2&&Array.from(document.querySelectorAll('.session-row.selected')).every(el=>el.dataset.sessionId.startsWith('dictation-'))`), 'switching kind filters removes hidden sessions from selection');
    await keyboard('.sl-main', 'a', { metaKey: true });
    await expectSelection(['dictation-today', 'dictation-yesterday'], 'Command A selects only sessions visible under the current filter');
    await keyboard('.transcript-search input', 'Backspace', { metaKey: true });
    check(await run('qa.deleteCalls.length===0'), 'Command Backspace inside search never deletes sessions');
    await doubleRow('dictation-today');
    await keyboard(row('dictation-today') + ' input', 'Backspace', { metaKey: true });
    check(await run('qa.deleteCalls.length===0'), 'Command Backspace inside a rename input never deletes sessions');
    await keyboard(row('dictation-today') + ' input', 'Escape');

    await reset();
    for (const [id, title] of [['recording-today', '双击改名后的录制'], ['dictation-today', '双击改名后的输入']]) {
      await doubleRow(id);
      check(await run(`document.activeElement===document.querySelector(${JSON.stringify(row(id) + ' input')})`), id + ' double click focuses its rename input');
      await input(row(id) + ' input', '取消的名称');
      await keyboard(row(id) + ' input', 'Escape');
      check(await run('qa.renameCalls.length===' + (id === 'recording-today' ? 0 : 1)), id + ' Escape discards the draft without saving');
      await doubleRow(id);
      await input(row(id) + ' input', title);
      await keyboard(row(id) + ' input', 'Enter');
      await until(`document.querySelector(${JSON.stringify(row(id) + ' .sl-title')})?.textContent===${JSON.stringify(title)}`);
      check(await run(`qa.renameCalls.at(-1).sessionId===${JSON.stringify(id)}&&document.querySelector('.session-title h2').textContent===${JSON.stringify(title)}`), id + ' Enter renames only that session and updates its detail title');
      await run(`document.querySelector('.session-title h2').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,detail:2}))`);
      await until(`Boolean(document.querySelector('.session-title input'))`);
      await input('.session-title input', '标题处取消的名称');
      await click('.session-title .name-editor button', '取消');
      check(await run(`document.querySelector('.session-title h2').textContent===${JSON.stringify(title)}&&document.activeElement===document.querySelector('.session-title-menu')`), id + ' detail title also supports double click and Cancel restores trigger focus');
    }

    await reset();
    await clickRow('recording-today');
    await clickRow('dictation-today', { metaKey: true });
    await click('.session-selection-bar button');
    await until('qa.deleteCalls.length===1');
    check(await run('qa.pendingDeletes.length===1'), 'batch deletion starts with a single sequential request');
    await clickRow('recording-earlier');
    await run(`qa.select('recording-earlier')`);
    await until(`qa.state.selectedId==='recording-earlier'&&document.querySelector('.session-title h2')?.textContent==='上周的项目回顾'`);
    await finishDelete();
    await until('qa.deleteCalls.length===2');
    await finishDelete();
    check(await run(`JSON.stringify(qa.deleteCalls)===JSON.stringify(['recording-today','dictation-today'])&&qa.state.sessions.some(row=>row.id==='recording-earlier')`), 'in-flight batch keeps the original target snapshot when the active session changes externally');
    check(await run(`document.querySelectorAll('.name-undo').length===1&&document.querySelector('.name-undo').textContent.includes('2')`), 'two deleted sessions produce one compact undo notice');
    await click('.name-undo button');
    await until('qa.undoCalls.length===2&&qa.state.sessions.length===6');
    check(await run(`JSON.stringify([...qa.undoCalls].sort())===JSON.stringify(['dictation-today','recording-today'])&&qa.state.deletions.length===0`), 'one Undo restores exactly the whole deleted batch');

    await reset();
    await clickRow('recording-today');
    await clickRow('dictation-yesterday', { metaKey: true });
    await click('.session-selection-bar button');
    await finishDelete();
    await finishDelete({ ok: false, error: '测试：会话暂时无法删除，请重试' });
    await until(`Boolean(document.querySelector('.slist [role=alert]'))`);
    await expectSelection(['dictation-yesterday'], 'partial deletion retains only the failed session for retry');
    check(await run(`document.querySelector('.slist [role=alert]').textContent.includes('重试')&&qa.state.sessions.some(row=>row.id==='dictation-yesterday')&&!qa.state.sessions.some(row=>row.id==='recording-today')`), 'partial failure is visible and does not claim the failed session was deleted');
    await click('.session-selection-bar button');
    await finishDelete();
    check(await run(`JSON.stringify(qa.deleteCalls)===JSON.stringify(['recording-today','dictation-yesterday','dictation-yesterday'])`), 'retry requests only the failed session, never the already deleted one');

    await reset();
    await clickRow('recording-today');
    await clickRow('dictation-today', { metaKey: true });
    await filter('输入');
    await keyboard('.sl-main', 'a', { metaKey: true });
    await keyboard('.sl-main', 'Backspace', { metaKey: true });
    await finishDelete();
    await finishDelete();
    check(await run(`JSON.stringify([...qa.deleteCalls].sort())===JSON.stringify(['dictation-today','dictation-yesterday'])&&qa.state.sessions.filter(row=>row.kind==='recording').length===4`), 'Command Backspace in the list deletes the visible selected kind without hidden sessions');

    await reset();
    await clickRow('recording-today');
    await clickRow('protected-recording', { metaKey: true });
    check(await run(`document.querySelector('.session-selection-bar button').disabled`), 'a batch containing an active recording is disabled as a whole');
    await keyboard('.sl-main', 'Backspace', { metaKey: true });
    await context('protected-recording');
    check(await run(`document.querySelectorAll('.session-menu button').length===1&&document.querySelector('.session-menu button').disabled&&qa.deleteCalls.length===0`), 'keyboard and context menu also protect an active recording and its selected companions');
    const protectedMenuFocus = await run(`(()=>{const el=document.activeElement;return {tag:el.tagName,className:el.className,role:el.getAttribute('role'),sessionId:el.closest('[data-session-id]')?.getAttribute('data-session-id')??null};})()`);
    await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    await pause();
    const protectedMenuEscape = { focusBeforeEscape: protectedMenuFocus, menuRemains: await run(`Boolean(document.querySelector('.session-menu'))`), expectedSelection: ['recording-today', 'protected-recording'].sort(), actualSelection: await selection() };
    writeFileSync(join(config.evidence, 'protected-menu-escape.json'), JSON.stringify(protectedMenuEscape, null, 2));
    check(!protectedMenuEscape.menuRemains, 'Escape from the actual focused element dismisses a menu whose only action is disabled');
    await expectSelection(['recording-today', 'protected-recording'], 'Escape from a disabled-action menu preserves its protected multiple selection');
    await run(`document.querySelector(${JSON.stringify(row('protected-recording') + ' > .sl-row')}).dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,detail:2}))`);
    await pause();
    check(await run(`!document.querySelector(${JSON.stringify(row('protected-recording') + ' input')})&&qa.renameCalls.length===0`), 'an active recording cannot be renamed by double click');

    await reset();
    await clickRow('recording-today');
    await clickRow('dictation-today', { metaKey: true });
    for (const theme of ['light', 'dark']) for (const [size, width] of [['desktop', 1180], ['compact', 760]]) {
      nativeTheme.themeSource = theme;
      win.setSize(width, 820);
      await pause();
      const geometry = await run(`(()=>{const rows=Array.from(document.querySelectorAll('.session-row')).map(el=>el.getBoundingClientRect());const gaps=rows.slice(1).map((rect,index)=>rect.top-rows[index].bottom);return {gaps,overflow:document.documentElement.scrollWidth>innerWidth,rowsFit:rows.every(rect=>rect.left>=0&&rect.right<=innerWidth),barFit:(()=>{const bar=document.querySelector('.session-selection-bar'),rect=bar.getBoundingClientRect();return bar.scrollWidth<=rect.width+1&&rect.right<=innerWidth;})()};})()`);
      check(geometry.gaps.every(gap => gap >= 4), theme + ' ' + size + ' every adjacent session row has at least 4px separation');
      check(!geometry.overflow && geometry.rowsFit && geometry.barFit, theme + ' ' + size + ' rows and bulk controls have no horizontal overflow');
      await screenshot(size + '-' + theme + '-selection');
    }

    // The real bridge can publish a selectedId snapshot after further local clicks.
    // Capture both sequences before asserting so a RED records each observed set.
    const delayedSelectionResults = [];
    await reset();
    await run('qa.delaySelections()');
    await clickRow('dictation-today', { metaKey: true });
    await expectSelection(['recording-today', 'dictation-today'], 'Command adds a session immediately while its selection IPC is pending');
    await clickRow('dictation-today', { metaKey: true });
    await expectSelection(['recording-today'], 'Command removes the same session before its earlier selection IPC completes');
    check(await run(`qa.pendingSelections.length===1&&qa.state.selectedId==='recording-today'`), 'delayed fixture preserves the old active snapshot until explicitly flushed');
    await run('qa.resolveSelection()');
    await until(`qa.state.selectedId==='dictation-today'`);
    await pause();
    delayedSelectionResults.push({ scenario: 'late snapshot for a Command-deselected row', expected: ['recording-today'], actual: await selection() });

    await reset();
    await run('qa.delaySelections()');
    await clickRow('dictation-today');
    await clickRow('recording-yesterday');
    await expectSelection(['recording-yesterday'], 'a second ordinary click selects its row while both selection IPCs are pending');
    check(await run(`qa.pendingSelections.length===2`), 'two ordinary clicks leave independently controlled selection responses');
    await run('qa.resolveSelection(1)');
    await until(`qa.state.selectedId==='recording-yesterday'`);
    await run('qa.resolveSelection()');
    await until(`qa.state.selectedId==='dictation-today'`);
    await pause();
    delayedSelectionResults.push({ scenario: 'older ordinary-click snapshot arrives after the newer selection', expected: ['recording-yesterday'], actual: await selection() });
    writeFileSync(join(config.evidence, 'delayed-selection-results.json'), JSON.stringify(delayedSelectionResults, null, 2));
    for (const value of delayedSelectionResults) {
      assert.deepEqual(value.actual, value.expected, value.scenario);
      check(true, value.scenario + ' leaves the most recent local selection unchanged');
    }

    await reset();
    await click('.sl-foot button', '设置');
    await until(`Boolean(document.querySelector('#personal-hotwords:not(:disabled)'))&&Boolean(document.querySelector('.usage-overview'))`);
    await expectSelection([], 'opening Settings clears the sidebar selection');
    await run('qa.delaySelections()');
    await clickRow('dictation-today');
    check(await run(`qa.pendingSelections.length===1&&qa.state.selectedId==='recording-today'&&!document.querySelector('#personal-hotwords')`), 'clicking a session leaves Settings before its delayed snapshot arrives');
    await expectSelection(['dictation-today'], 'leaving Settings retains the clicked row instead of restoring the old active snapshot');
    await run('qa.resolveSelection()');
    await until(`qa.state.selectedId==='dictation-today'`);
    await expectSelection(['dictation-today'], 'the delayed snapshot preserves the row selected when leaving Settings');

    await reset();
    await filter('输入');
    await keyboard('.sl-main', 'a', { metaKey: true });
    await expectSelection(['dictation-today', 'dictation-yesterday'], 'explicit navigation fixture begins with a filtered multiple selection');
    await run(`qa.navigate('recording-yesterday')`);
    await until(`document.querySelectorAll('.session-row').length===6&&document.querySelector('.session-title h2')?.textContent==='昨天的设计讨论'`);
    await expectSelection(['recording-yesterday'], 'an explicit external library navigation selects its session and reveals it across filters');
    writeFileSync(join(config.evidence, 'result.json'), JSON.stringify({ pass: true, scope: 'isolated offscreen Chromium; real React Library and synthetic API; no production data, main IPC, macOS permissions, audio or cloud validation', results, screenshots }, null, 2));
    console.log(JSON.stringify({ pass: true, assertions: results.length, evidence: config.evidence }));
    win.destroy();
    app.exit(0);
  } catch (error) {
    if (win && !win.isDestroyed()) {
      try { const path = join(config.evidence, 'failure.png'); writeFileSync(path, (await win.webContents.capturePage()).toPNG()); screenshots.push(path); } catch {}
    }
    writeFileSync(join(config.evidence, 'result.json'), JSON.stringify({ pass: false, error: String(error), results, screenshots }, null, 2));
    console.error(error);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(1);
  }
}
writeFileSync(join(temp, 'runner.mjs'), `(${runElectron.toString()})(${JSON.stringify({ temp, evidence })});`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const run = spawnSync(electron, [join(temp, 'runner.mjs')], { encoding: 'utf8', env, timeout: 120000 });
process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');
let pass = false;
try { pass = JSON.parse(readFileSync(join(evidence, 'result.json'), 'utf8')).pass === true; } catch {}
console.log('Evidence: ' + evidence);
if (run.error) console.error(run.error);
process.exitCode = run.status === 0 && pass ? 0 : 1;
