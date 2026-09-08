// Actual Library + RecordingControls rendered in temporary offscreen Chromium.
// Synthetic state/API only; never loads the installed app, production data or network.
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';
const temp=mkdtempSync(join(tmpdir(),'earshot-realtime-ui-'));
const evidence=resolve(process.env.EARSHOT_UI_EVIDENCE??'../earshot-release-evidence/2026-09-08-realtime-recovery',`realtime-ui-${new Date().toISOString().replace(/[:.]/g,'-')}`);
mkdirSync(evidence,{recursive:true});
const fixture=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Library} from ${JSON.stringify(resolve('src/renderer/Library.tsx'))};import ${JSON.stringify(resolve('src/renderer/styles.css'))};
const detail={id:'fixture-only',title:'团队讨论 · 实时转写状态',startedAt:'2026-09-08T03:00:00Z',endedAt:null,durationSec:480,status:'recording',jobs:{live:'running',refined:'idle',speakers:'idle'},people:[],bookmarks:[],turns:[{id:'one',track:'other',speaker:'对方',text:'先确认本周的交付内容。',tStartMs:12000},{id:'two',track:'you',speaker:'你',text:'好的，原始录音会继续保存在本机。',tStartMs:24000}]};
const tracks={you:{status:'reconnecting',attempt:1,category:'transport',retryDelayMs:2000},other:{status:'connected',attempt:0}};
let update;const calls=[],pending=[];window.earshot={searchTranscripts:async()=>({ok:true,hits:[],truncated:false}),onChange:()=>()=>{},retryRealtime:()=>{calls.push('retry');return new Promise(resolve=>pending.push(resolve));},selectSession:async()=>{},stop:async()=>({ok:true})};
window.qa={calls,pending,change:(connection,tracks,phase='recording')=>update(s=>({...s,capturePhase:phase,recording:{...s.recording,phase,connection,connectionDetail:{tracks}}})),resolve:result=>pending.shift()(result)};
function App(){const [snap,setSnap]=useState({hasApiKey:true,autoDiarize:true,permissions:{microphone:'granted',screen:'granted'},recording:{sessionId:detail.id,elapsedSec:480,phase:'recording',glanceVisible:false,turns:detail.turns,connection:'reconnecting',connectionDetail:{tracks}},capturePhase:'recording',playingSessionId:null,sessions:[detail],selectedId:detail.id,selected:detail});update=setSnap;return <Library snap={snap} refresh={async()=>{}}/>;}createRoot(document.getElementById('root')).render(<App/>);
`;
await build({stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:'realtime-fixture.jsx',loader:'jsx'},outfile:join(temp,'fixture.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',loader:{'.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"'}});
writeFileSync(join(temp,'index.html'),`<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>`);
async function runner(config){
 const {app,BrowserWindow,session,nativeTheme}=await import('electron');const {join}=await import('node:path');const {writeFileSync}=await import('node:fs');const assert=(await import('node:assert/strict')).default;
 app.setPath('userData',join(config.temp,'profile'));app.on('window-all-closed',()=>{});await app.whenReady();let win;const checks=[],observations=[],screenshots=[];
 const check=(value,label)=>{assert.ok(value,label);checks.push({pass:true,assertion:label});};
 try{
 const isolated=session.fromPartition('realtime-ui-only');isolated.setPermissionRequestHandler((_w,_p,cb)=>cb(false));isolated.setPermissionCheckHandler(()=>false);isolated.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!d.url.startsWith('file://'+config.temp+'/')}));
 win=new BrowserWindow({show:false,width:760,height:820,webPreferences:{session:isolated,offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));await win.loadFile(join(config.temp,'index.html'));
 const run=code=>win.webContents.executeJavaScript(code,true),pause=()=>new Promise(r=>setTimeout(r,80));
 const until=async code=>{for(let i=0;i<80;i++){if(await run(code))return;await pause();}throw Error('Wait expired '+code);};
 const change=async(connection,you,other={status:'connected',attempt:0},phase='recording')=>{await run(`qa.change(${JSON.stringify(connection)},${JSON.stringify({you,other})},${JSON.stringify(phase)})`);await pause();};
 const shot=async name=>{await pause();const path=join(config.evidence,name+'.png');writeFileSync(path,(await win.webContents.capturePage()).toPNG());screenshots.push(path);};
 await until(`Boolean(document.querySelector('.realtime-notice'))`);
 for(const theme of ['light','dark']){
  nativeTheme.themeSource=theme;await change('reconnecting',{status:'reconnecting',attempt:1,category:'transport',retryDelayMs:2000});
  check(await run(`document.querySelector('.realtime-notice').textContent.includes('实时转写正在自动重连，原始录音仍在保存')`),theme+' reconnecting text accurately states automatic recovery and retained recording');
  check(await run(`!document.querySelector('.realtime-notice button')&&document.querySelector('.recording-clock').textContent.includes('录音中')&&!document.querySelector('.stop').disabled`),theme+' automatic retry exposes no manual retry and recording stop remains available');
  check(await run(`(()=>{const n=document.querySelector('.realtime-notice'),r=n.getBoundingClientRect();return r.right<=innerWidth&&n.scrollWidth<=r.width&&document.documentElement.scrollWidth<=innerWidth;})()`),theme+' 760px automatic recovery notice has no horizontal overflow');
  check(await run(`document.querySelector('.realtime-notice').textContent.includes('麦克风：网络连接中断')&&document.querySelector('.realtime-notice').textContent.includes('重试间隔 2 秒')&&document.querySelector('.realtime-notice').textContent.includes('系统声音：已连接')`),theme+' automatic retry identifies affected track, cause, planned 2-second interval and healthy other track');
  await shot('compact-'+theme+'-automatic-reconnect');
  await change('disconnected',{status:'disconnected',attempt:0,category:'quota'});
  check(await run(`document.querySelector('.realtime-notice').textContent.includes('实时转写已断开，原始录音仍在保存')&&document.querySelector('.realtime-notice').textContent.includes('麦克风：账户余额或额度不足')`),theme+' terminal quota identifies microphone reason and continuing original recording');
  check(await run(`document.querySelector('.realtime-notice button').textContent==='重新连接'&&!document.querySelector('.realtime-notice button').disabled&&document.querySelector('.realtime-notice button').title==='重连后继续识别后续音频；缺失段在停录后处理'`),theme+' terminal failure enables manual retry with accurate future-audio scope');
  check(await run(`!document.querySelector('.realtime-notice').textContent.includes('系统声音：连接中断')&&!document.querySelector('.realtime-notice').textContent.includes('自动重连已达上限')`),theme+' connected other track is not reported failed and quota does not falsely claim exhausted attempts');
  check(await run(`(()=>{const n=document.querySelector('.realtime-notice'),r=n.getBoundingClientRect(),b=n.querySelector('button').getBoundingClientRect();return r.right<=innerWidth&&b.right<=innerWidth&&n.scrollWidth<=r.width&&document.documentElement.scrollWidth<=innerWidth;})()`),theme+' 760px terminal quota notice and retry fit in viewport');
  await shot('compact-'+theme+'-quota-disconnected');
 }
 await run(`document.querySelector('.realtime-notice button').click();document.querySelector('.realtime-notice button').click()`);await pause();check(await run(`qa.calls.length===1&&document.querySelector('.realtime-notice button').disabled`),'manual retry double click sends one request and disables pending button');
 await run(`qa.resolve({ok:false,error:'账户问题尚未解决，请检查额度'})`);await until(`Boolean(document.querySelector('.realtime-notice [role=alert]'))`);check(await run(`document.querySelector('.realtime-notice [role=alert]').textContent==='账户问题尚未解决，请检查额度'&&!document.querySelector('.realtime-notice button').disabled`),'manual retry failure is actionable and re-enables retry without hiding cause');
 await change('disconnected',{status:'disconnected',attempt:5,category:'transport'});check(await run(`document.querySelector('.realtime-notice').textContent.includes('麦克风：网络连接中断，自动重连已达上限')`),'retry exhaustion explains network cause and reached retry limit');
 await change('disconnected',{status:'disconnected',attempt:0,category:'quota'},{status:'connected',attempt:0},'stopping');check(await run(`document.querySelector('.realtime-notice button').disabled`),'manual retry is disabled while recording stops');
 await change('connected',{status:'connected',attempt:0});check(await run(`document.querySelector('.realtime-notice').textContent==='实时转写正常'&&!document.querySelector('.realtime-notice button')&&!document.querySelector('.realtime-notice [role=alert]')`),'connected state removes old error and manual retry');
 observations.push({classification:'verified-presentation',state:'you reconnecting / transport / attempt 1 / retryDelayMs 2000; other connected',observed:'Automatic recovery presents track name, network reason, planned retry interval and healthy other track. Interval is descriptive, not a countdown.',source:'RecordingControls.tsx actual React DOM',notBackendFailure:true});
 writeFileSync(join(config.evidence,'result.json'),JSON.stringify({pass:true,scope:'isolated offscreen Chromium actual Library and RecordingControls with synthetic API; no installed-app, live provider, microphone, audio or TCC validation',checks,observations,screenshots},null,2));console.log(JSON.stringify({pass:true,assertions:checks.length,observations:observations.length,evidence:config.evidence}));win.destroy();app.exit(0);
 }catch(error){writeFileSync(join(config.evidence,'result.json'),JSON.stringify({pass:false,error:String(error),checks,observations,screenshots},null,2));console.error(error);if(win&&!win.isDestroyed())win.destroy();app.exit(1);}
}
writeFileSync(join(temp,'runner.mjs'),`(${runner.toString()})(${JSON.stringify({temp,evidence})});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const result=spawnSync(electron,[join(temp,'runner.mjs')],{encoding:'utf8',env,timeout:60000});process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');let pass=false;try{pass=JSON.parse(readFileSync(join(evidence,'result.json'),'utf8')).pass===true;}catch{}console.log('Evidence: '+evidence);if(result.error)console.error(result.error);process.exitCode=result.status===0&&pass?0:1;
