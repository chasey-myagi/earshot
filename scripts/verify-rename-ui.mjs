// Isolated real React Library UI. No main-process IPC, account, audio or network.
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';
const temp = mkdtempSync(join(tmpdir(), 'earshot-rename-ui-'));
const evidence = resolve(process.env.EARSHOT_UI_EVIDENCE ?? '../earshot-release-evidence/2026-09-08-full-upgrade', `rename-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(evidence, { recursive: true });
const fixture = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Library} from ${JSON.stringify(resolve('src/renderer/Library.tsx'))};
import ${JSON.stringify(resolve('src/renderer/styles.css'))};
const make=(id,title)=>({id,title,startedAt:'2026-09-08T02:00:00Z',endedAt:'2026-09-08T02:30:00Z',durationSec:1800,status:'complete',jobs:{live:'done',refined:'done',speakers:'done'},people:['李华'],bookmarks:[],turns:[
{id:'one',track:'other',speaker:'王明',text:'我们先确认今天的交付范围，再安排下一步。',tStartMs:12000,correction:{revision:'r0',originalText:'我们先确认今天的交付范围，再安排下一步。',originalSpeaker:'王明',edited:false,speakerOverridden:false,canUndo:false}},
{id:'two',track:'you',speaker:'你',text:'好的，我会把录音留在本机，方便会后核对。',tStartMs:28000},
{id:'three',track:'other',speaker:'王明',text:'下周二再一起检查进展。',tStartMs:47000}]});
const sessions=[make('alpha','产品评审 · 九月计划'),make('beta','团队同步 · 设计讨论')];
const logs=[],pending=[];let state,update;
const request=(action,input)=>{logs.push({action,...input});return new Promise(resolve=>pending.push({action,input,resolve}));};
window.earshot={searchTranscripts:async()=>({ok:true,hits:[],truncated:false}),onChange:()=>()=>{},selectSession:async id=>{update(s=>({...s,selectedId:id,selected:s.sessions.find(v=>v.id===id)}));},
renameSession:input=>request('session',input),renameSpeaker:input=>request('speaker',input),correctTurn:input=>request('turn',input),undoTurnCorrection:async()=>({ok:true}),resetTurnCorrection:async()=>({ok:true})};
window.qa={logs,pending,select:id=>window.earshot.selectSession(id),resolve(result){const req=pending.shift();if(!req)throw Error('No pending request');if(result.ok&&req.action==='session')update(s=>{const sessions=s.sessions.map(row=>row.id===req.input.sessionId?{...row,title:req.input.title}:row);return{...s,sessions,selected:sessions.find(row=>row.id===s.selectedId)};});req.resolve(result);}};
function App(){[state,update]=useState({hasApiKey:true,autoDiarize:true,permissions:{microphone:'granted',screen:'granted'},recording:null,capturePhase:'idle',playingSessionId:null,sessions,selectedId:'alpha',selected:sessions[0]});return <Library snap={state} refresh={async()=>{}}/>;}
createRoot(document.getElementById('root')).render(<App/>);
`;
await build({stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:'rename-fixture.jsx',loader:'jsx'},outfile:join(temp,'fixture.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',loader:{'.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"'}});
writeFileSync(join(temp,'index.html'),`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>`);
async function runElectron(config){
 const {app,BrowserWindow,session,nativeTheme}=await import('electron');const {join}=await import('node:path');const {writeFileSync}=await import('node:fs');const assert=(await import('node:assert/strict')).default;
 app.setPath('userData',join(config.temp,'profile'));app.on('window-all-closed',()=>{});
 await app.whenReady();const results=[],screenshots=[];let win;
 const check=(value,label)=>{assert.ok(value,label);results.push({pass:true,assertion:label});};
 try{
 const isolated=session.fromPartition('rename-qa');isolated.setPermissionRequestHandler((_w,_p,cb)=>cb(false));isolated.setPermissionCheckHandler(()=>false);
 isolated.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith('file://'+config.temp+'/')}));
 win=new BrowserWindow({show:false,width:1180,height:820,webPreferences:{session:isolated,offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 await win.loadFile(join(config.temp,'index.html'));
 const run=code=>win.webContents.executeJavaScript(code,true);const pause=()=>new Promise(r=>setTimeout(r,60));
 const until=async code=>{for(let i=0;i<100;i++){if(await run(code))return;await pause();}throw Error('Wait expired: '+code);};
 const click=async(selector,text)=>{await run(`(()=>{const els=Array.from(document.querySelectorAll(${JSON.stringify(selector)}));const el=${text?`els.find(el=>el.textContent.trim()===${JSON.stringify(text)})`:'els[0]'};if(!el)throw Error('Missing click target');el.click();})()`);await pause();};
 const input=async(selector,value)=>{await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause();};
 const key=async(selector,key,composing=false)=>{await run(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true,isComposing:${composing}}))`);await pause();};
 const submit=async selector=>{await run(`document.querySelector(${JSON.stringify(selector)}).requestSubmit()`);await pause();};
 const rowOpen=async()=>{await run(`document.querySelector('.session-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);await pause();await click('.session-menu button','改名');};
 const titleOpen=async()=>{await click('.session-title-menu');await click('.session-menu button','改名');};
 const groupOpen=async()=>{await click('.t-name.click');await until(`Boolean(document.querySelector('.pop input'))`);};
 const cancel=async selector=>click(selector+' button','取消');
 const screenshot=async name=>{await pause();const path=join(config.evidence,name+'.png');writeFileSync(path,(await win.webContents.capturePage()).toPNG());screenshots.push(path);};
 const geometry=async(selector)=>run(`(()=>{const form=document.querySelector(${JSON.stringify(selector)}),box=form.getBoundingClientRect(),input=form.querySelector('input').getBoundingClientRect(),buttons=Array.from(form.querySelectorAll('.name-editor-actions button')).map(el=>el.getBoundingClientRect());return input.left>=box.left&&input.right<=box.right+1&&buttons[1].left-buttons[0].right>=7&&buttons.every(b=>b.right<=box.right+1)&&document.documentElement.scrollWidth<=innerWidth;})()`);
 await until(`Boolean(document.querySelector('.session-title h2'))`);
 await rowOpen();check(await run(`document.activeElement===document.querySelector('.session-row input')&&document.activeElement.selectionEnd===document.activeElement.value.length`),'sidebar opens with focused selected title');
 check(await geometry('.session-row .name-editor'),'sidebar input and separated buttons fit within padded form');
 check(await run(`document.querySelector('.session-row button[type=submit]').disabled`),'unchanged title cannot submit');
 await input('.session-row input','   ');check(await run(`document.querySelector('.session-row button[type=submit]').disabled`),'blank title cannot submit');
 await input('.session-row input','改名后的会议');
 await run(`document.querySelector('.session-row input').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))`);await key('.session-row input','Enter',true);await submit('.session-row form');check(await run(`qa.logs.length===0`),'IME composition and Enter do not save session title');
 await run(`document.querySelector('.session-row input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`);
 await run(`document.querySelector('.session-row form').requestSubmit();document.querySelector('.session-row form').requestSubmit()`);await pause();check(await run(`qa.logs.length===1&&document.querySelector('.session-row button[type=submit]').textContent==='保存中…'`),'repeated session submit sends once and shows busy');
 await key('.session-row input','Escape');check(await run(`Boolean(document.querySelector('.session-row input'))`),'busy Escape does not dismiss pending title save');
 await run(`qa.resolve({ok:false,error:'名称没能保存，请重试'})`);await until(`Boolean(document.querySelector('.name-editor-error'))`);
 check(await run(`document.querySelector('.session-row input').value==='改名后的会议'&&!document.querySelector('.session-row button[type=submit]').disabled`),'failed title save preserves draft and enables retry');
 await screenshot('sidebar-error-dark');await submit('.session-row form');await run(`qa.resolve({ok:true})`);await until(`document.querySelector('.session-row .sl-title')?.textContent==='改名后的会议'`);check(true,'retry updates actual sidebar title');
 await titleOpen();await input('.session-title input','旧会话迟到结果');await submit('.session-title form');await run(`qa.select('beta')`);await until(`document.querySelector('.session-title h2')?.textContent==='团队同步 · 设计讨论'`);await titleOpen();await input('.session-title input','新会话未保存草稿');await run(`qa.resolve({ok:false,error:'旧请求错误'})`);await pause();
 check(await run(`document.querySelector('.session-title input').value==='新会话未保存草稿'&&!document.querySelector('.session-title [role=alert]')`),'late previous session result cannot change new title draft or error');
 await key('.session-title input','Escape');check(await run(`document.activeElement===document.querySelector('.session-title-menu')`),'Escape cancels title rename and restores menu focus');
 await groupOpen();check(await run(`document.querySelector('.pop').textContent.includes('2 段发言')&&document.querySelector('.pop button[type=submit]').disabled`),'group editor declares scope and disables unchanged name');
 await click('.pop-people button','李华');check(await run(`qa.pending.length===0&&document.querySelector('.pop input').value==='李华'&&document.querySelector('.pop').textContent.includes('归到已有')`),'existing name choice only changes draft and explains merge');
 await input('.pop input','赵敏');await key('.pop input','Enter',true);check(await run(`qa.pending.length===0`),'group IME Enter does not submit');
 await run(`document.querySelector('.pop form').requestSubmit();document.querySelector('.pop form').requestSubmit()`);await pause();check(await run(`qa.pending.length===1&&qa.pending[0].input.sessionId==='beta'&&qa.pending[0].input.from==='王明'`),'group repeated save is bound to selected session and original speaker');
 await run(`qa.resolve({ok:false,error:'名字没能保存，请重试'})`);await until(`Boolean(document.querySelector('.pop [role=alert]'))`);check(await run(`document.querySelector('.pop input').value==='赵敏'`),'group save error stays alongside retained draft');await screenshot('speaker-error-dark');
 await submit('.pop form');await run(`qa.select('alpha')`);await until(`!document.querySelector('.pop')`);await groupOpen();await input('.pop input','新编辑器姓名');await run(`qa.resolve({ok:false,error:'过期姓名请求'})`);await pause();check(await run(`document.querySelector('.pop input').value==='新编辑器姓名'&&!document.querySelector('.pop [role=alert]')`),'late old group result cannot overwrite newly opened editor');await cancel('.pop');
 await groupOpen();await input('.pop input','键盘保存姓名');await key('.pop input','Enter');await until(`qa.pending.length===1`);check(await run(`qa.pending[0].input.to==='键盘保存姓名'`),'DOM Enter key saves group name outside IME composition');await run(`qa.resolve({ok:true})`);await until(`!document.querySelector('.pop')`);
 await click('.turn-edit-button');check(await run(`document.querySelector('.transcript-editor button[type=submit]').disabled`),'single-turn editor disables unchanged save');await input('.transcript-editor input','单段姓名');
 await key('.transcript-editor input','Enter',true);check(await run(`qa.pending.length===0`),'single-turn IME Enter does not submit');
 await run(`document.querySelector('.transcript-editor').requestSubmit();document.querySelector('.transcript-editor').requestSubmit()`);await pause();check(await run(`qa.pending.length===1&&qa.pending[0].action==='turn'&&qa.pending[0].input.speaker==='单段姓名'&&qa.pending[0].input.revision==='r0'`),'single-turn synchronous guard sends one correction with revision');
 await run(`qa.resolve({ok:false,error:'这一段未保存，请重试'})`);await until(`Boolean(document.querySelector('.transcript-editor [role=alert]'))`);check(await run(`document.querySelector('.transcript-editor input').value==='单段姓名'`),'single-turn failure preserves draft');await screenshot('turn-error-dark');await submit('.transcript-editor');await run(`qa.select('beta')`);await until(`!document.querySelector('.transcript-editor')`);await click('.turn-edit-button');await input('.transcript-editor input','新的单段草稿');await run(`qa.resolve({ok:true})`);await pause();check(await run(`document.querySelector('.transcript-editor input').value==='新的单段草稿'`),'old single-turn completion cannot close new session editor');await key('.transcript-editor input','Escape');check(await run(`!document.querySelector('.transcript-editor')&&document.activeElement.classList.contains('turn-edit-button')`),'single-turn Escape restores edit-button focus');
 for(const theme of ['dark','light'])for(const [size,width] of [['desktop',1180],['compact',760]]){
  nativeTheme.themeSource=theme;win.setSize(width,820);await pause();
  await rowOpen();await input('.session-row input','九月交付范围与下一步计划');check(await geometry('.session-row .name-editor'),theme+' '+size+' sidebar control geometry');await screenshot(size+'-'+theme+'-sidebar');await cancel('.session-row .name-editor');
  await titleOpen();await input('.session-title input','团队同步 · 九月设计讨论');check(await geometry('.session-title .name-editor'),theme+' '+size+' title control geometry');await screenshot(size+'-'+theme+'-title');await cancel('.session-title .name-editor');
  await groupOpen();await input('.pop input','陈佳');check(await run(`(()=>{const r=document.querySelector('.pop').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()`),theme+' '+size+' speaker popover stays in viewport');await screenshot(size+'-'+theme+'-speaker');await cancel('.pop');
  await click('.turn-edit-button');await input('.transcript-editor input','陈佳');check(await run(`(()=>{const r=document.querySelector('.transcript-editor').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&document.querySelector('.transcript-editor').scrollWidth<=r.width;})()`),theme+' '+size+' single-turn editor has no horizontal overflow');await screenshot(size+'-'+theme+'-turn');await cancel('.transcript-editor');
 }
 writeFileSync(join(config.evidence,'result.json'),JSON.stringify({pass:true,scope:'isolated offscreen Chromium; real React Library, synthetic API; no main IPC, production data, macOS permissions, audio or cloud validation',results,screenshots},null,2));console.log(JSON.stringify({pass:true,assertions:results.length,evidence:config.evidence}));win.destroy();app.exit(0);
 }catch(error){writeFileSync(join(config.evidence,'result.json'),JSON.stringify({pass:false,error:String(error),results,screenshots},null,2));console.error(error);if(win&&!win.isDestroyed())win.destroy();app.exit(1);}
}
writeFileSync(join(temp,'runner.mjs'),`(${runElectron.toString()})(${JSON.stringify({temp,evidence})});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const run=spawnSync(electron,[join(temp,'runner.mjs')],{encoding:'utf8',env,timeout:120000});process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');
let pass=false;try{pass=JSON.parse(readFileSync(join(evidence,'result.json'),'utf8')).pass===true;}catch{}
console.log('Evidence: '+evidence);if(run.error)console.error(run.error);process.exitCode=run.status===0&&pass?0:1;
