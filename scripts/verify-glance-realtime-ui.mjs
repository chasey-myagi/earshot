// Actual Glance + RecordingControls rendered in temporary offscreen Chromium.
// Synthetic state/API only; never loads the installed app, production data or network.
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';
const temp=mkdtempSync(join(tmpdir(),'earshot-glance-ui-'));
const evidence=resolve(process.env.EARSHOT_UI_EVIDENCE??'../earshot-release-evidence/2026-09-08-realtime-recovery',`glance-realtime-ui-${new Date().toISOString().replace(/[:.]/g,'-')}`);
mkdirSync(evidence,{recursive:true});
const fixture=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Glance} from ${JSON.stringify(resolve('src/renderer/Glance.tsx'))};import ${JSON.stringify(resolve('src/renderer/styles.css'))};
const detail={id:'fixture-only',title:'团队讨论 · 实时转写状态',startedAt:'2026-09-08T03:00:00Z',endedAt:null,durationSec:480,status:'recording',jobs:{live:'running',refined:'idle',speakers:'idle'},people:[],bookmarks:[],turns:[{id:'one',track:'other',speaker:'对方',text:'先确认本周的交付内容。',tStartMs:12000},{id:'two',track:'you',speaker:'你',text:'好的，原始录音会继续保存在本机。',tStartMs:24000}]};
const tracks={you:{status:'reconnecting',attempt:1,category:'transport',retryDelayMs:2000},other:{status:'connected',attempt:0}};
let update;const calls=[],pending=[];window.earshot={searchTranscripts:async()=>({ok:true,hits:[],truncated:false}),onChange:()=>()=>{},hideGlance:async()=>{},showLibrary:async()=>{},retryRealtime:()=>{calls.push('retry');return new Promise(resolve=>pending.push(resolve));},selectSession:async()=>{},stop:async()=>({ok:true})};
window.qa={calls,pending,warning:value=>update(s=>({...s,recording:{...s.recording,storageWarning:value}})),change:(connection,tracks,phase='recording')=>update(s=>({...s,capturePhase:phase,recording:{...s.recording,phase,connection,connectionDetail:{tracks}}})),resolve:result=>pending.shift()(result)};
function App(){const [snap,setSnap]=useState({hasApiKey:true,autoDiarize:true,permissions:{microphone:'granted',screen:'granted'},recording:{sessionId:detail.id,elapsedSec:480,phase:'recording',glanceVisible:false,turns:detail.turns,connection:'reconnecting',connectionDetail:{tracks}},capturePhase:'recording',playingSessionId:null,sessions:[detail],selectedId:detail.id,selected:detail});update=setSnap;return <Glance recording={snap.recording}/>;}createRoot(document.getElementById('root')).render(<App/>);
`;
await build({stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:'realtime-fixture.jsx',loader:'jsx'},outfile:join(temp,'fixture.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',loader:{'.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"'}});
writeFileSync(join(temp,'index.html'),`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>`);
async function runner(config){
 const {app,BrowserWindow,session,nativeTheme}=await import('electron');const {join}=await import('node:path');const {writeFileSync}=await import('node:fs');const assert=(await import('node:assert/strict')).default;
 app.setPath('userData',join(config.temp,'profile'));app.on('window-all-closed',()=>{});await app.whenReady();let win;const checks=[],screenshots=[],layouts=[];
 const check=(value,label)=>{assert.ok(value,label);checks.push({pass:true,assertion:label});};
 try{
 const isolated=session.fromPartition('glance-ui-only');isolated.setPermissionRequestHandler((_w,_p,cb)=>cb(false));isolated.setPermissionCheckHandler(()=>false);isolated.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file://'+config.temp+'/')}));
 win=new BrowserWindow({show:false,width:380,height:300,frame:false,webPreferences:{session:isolated,offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));await win.loadFile(join(config.temp,'index.html'));
 const run=code=>win.webContents.executeJavaScript(code,true),pause=()=>new Promise(r=>setTimeout(r,100));
 const until=async code=>{for(let i=0;i<80;i++){if(await run(code))return;await pause();}throw Error('Wait expired '+code);};
 await until(`Boolean(document.querySelector('.glance .realtime-notice'))`);
 const cases=[{name:'normal',connection:'connected',tracks:{you:{status:'connected',attempt:0},other:{status:'connected',attempt:0}}},{name:'reconnecting',connection:'reconnecting',tracks:{you:{status:'reconnecting',attempt:1,category:'transport',retryDelayMs:2000},other:{status:'connected',attempt:0}}},{name:'two-failed-storage-warning',connection:'disconnected',tracks:{you:{status:'disconnected',attempt:0,category:'quota'},other:{status:'disconnected',attempt:0,category:'auth'}},warning:'连接状态暂未保存。录音仍在继续，停止时可重试保存。'}];
 for(const [width,height,theme] of [[380,300,'light'],[320,220,'dark']]){
  win.setSize(width,height);nativeTheme.themeSource=theme;
  for(const test of cases){
   const name=`${width}x${height}-${theme}-${test.name}`;
   await run(`qa.change(${JSON.stringify(test.connection)},${JSON.stringify(test.tracks)});qa.warning(${JSON.stringify(test.warning??'')})`);await pause();
   const layout=await run(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};return {viewport:{width:innerWidth,height:innerHeight},pageWidth:document.documentElement.scrollWidth,body:rect(document.querySelector('.glance-body')),notice:rect(document.querySelector('.realtime-notice')),spans:[...document.querySelectorAll('.realtime-notice span')].map(rect),buttons:[...document.querySelectorAll('.glance-bar button,.glance-foot button')].map(b=>({label:b.getAttribute('aria-label')||b.textContent,...rect(b)})),text:document.querySelector('.realtime-notice').textContent};})()`);
   layouts.push({name,...layout});const path=join(config.evidence,name+'.png');await win.webContents.capturePage();await pause();writeFileSync(path,(await win.webContents.capturePage()).toPNG());screenshots.push(path);
   const inside=r=>r.width>0&&r.height>0&&r.left>=-1&&r.top>=-1&&r.right<=width+1&&r.bottom<=height+1;
   check(layout.pageWidth<=width,name+' no horizontal viewport overflow');
   check(['隐藏浮窗','停止录制','查看完整文字',...(test.connection==='disconnected'?['重新连接']:[])].every(label=>layout.buttons.some(b=>b.label===label))&&layout.buttons.length===(test.connection==='disconnected'?4:3),name+' required controls exist, including retry only after terminal disconnection');
   check(layout.buttons.every(inside),name+' all required controls remain inside viewport');
   const expectedText=test.connection==='connected'?['实时转写正常']:test.connection==='reconnecting'?['转写重连中，录音继续','麦克风：网络连接中断','重试间隔 2 秒','系统声音：已连接']:['转写已断开，录音继续','麦克风：账户余额或额度不足','系统声音：密钥无效或没有访问权限',test.warning];
   check(expectedText.every(text=>layout.text.includes(text))&&layout.spans.length===(test.connection==='connected'?1:test.warning?3:2),name+' required status, affected tracks, causes and storage warning are present');
   check(await run(`(()=>{const b=document.querySelector('.realtime-notice button');if(!b)return ${test.connection!=='disconnected'};const range=document.createRange();range.selectNodeContents(b);const text=range.getBoundingClientRect(),box=b.getBoundingClientRect();return text.left>=box.left-1&&text.right<=box.right+1&&text.top>=box.top-1&&text.bottom<=box.bottom+1;})()`),name+' manual retry text fits its button without vertical wrapping or clipping');
   check(layout.spans.every(inside),name+' every connection and storage status is inside viewport');
   check(layout.body.height>=40,name+' transcript scroll area retains at least 40px of viewport');
  }
 }
 writeFileSync(join(config.evidence,'result.json'),JSON.stringify({pass:true,scope:'actual Glance component in isolated offscreen Chromium; synthetic API; does not prove native always-on-top, TCC, display placement or physical input',checks,layouts,screenshots},null,2));console.log(JSON.stringify({pass:true,assertions:checks.length,evidence:config.evidence}));win.destroy();app.exit(0);
 }catch(error){writeFileSync(join(config.evidence,'result.json'),JSON.stringify({pass:false,error:String(error),checks,layouts,screenshots},null,2));console.error(error);if(win&&!win.isDestroyed())win.destroy();app.exit(1);}
}
writeFileSync(join(temp,'runner.mjs'),`(${runner.toString()})(${JSON.stringify({temp,evidence})});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const result=spawnSync(electron,[join(temp,'runner.mjs')],{encoding:'utf8',env,timeout:60000});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');let pass=false;try{pass=JSON.parse(readFileSync(join(evidence,'result.json'),'utf8')).pass===true;}catch{}console.log('Evidence: '+evidence);if(result.error)console.error(result.error);process.exitCode=result.status===0&&pass?0:1;
