// Actual built main + preload + React integration, with fixture-only appData/userData.
// No API key, capture, cloud, production bundle or real user session is used.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import electron from 'electron';
const workspace=process.cwd(),temp=mkdtempSync(join(tmpdir(),'earshot-real-app-qa-'));
const evidence=resolve(process.env.EARSHOT_APP_EVIDENCE??'../earshot-release-evidence/2026-09-08-full-upgrade',`app-integration-${new Date().toISOString().replace(/[:.]/g,'-')}`);
mkdirSync(evidence,{recursive:true});
const sourceHash=()=>{const hash=createHash('sha256');for(const file of [...readdirSync(resolve('src'),{recursive:true}).filter(file=>/\.(?:ts|tsx|css)$/.test(file)).map(file=>'src/'+file),'electron.vite.config.ts'].sort()){hash.update(file+'\0');hash.update(readFileSync(resolve(file)));hash.update('\0');}return hash.digest('hex');};
const sourceSha256=sourceHash();
const built=spawnSync('npm',['run','build'],{cwd:workspace,encoding:'utf8',timeout:120000});writeFileSync(join(evidence,'build.log'),(built.stdout??'')+(built.stderr??''));
if(built.status!==0)throw Error('Build failed; see '+join(evidence,'build.log'));
if(sourceHash()!==sourceSha256)throw Error('Runtime sources changed during build; rerun against a stable build');
const main=resolve('out/main/index.js'),mainSha256=createHash('sha256').update(readFileSync(main)).digest('hex');
const appData=join(temp,'appData'),support=join(appData,'Earshot');
for(const dir of [support,join(temp,'userData'),join(temp,'sessionData'),join(temp,'resources')])mkdirSync(dir,{recursive:true});
copyFileSync(resolve('assets/earshot-icon.png'),join(temp,'resources','earshot-icon.png'));
writeFileSync(join(support,'shortcuts.json'),JSON.stringify({enabled:false,meeting:'Control+Alt+Shift+F20',dictation:'Control+Alt+Shift+F19',delivery:'direct'}),{mode:0o600});
writeFileSync(join(support,'prefs.json'),JSON.stringify({autoDiarize:false}),{mode:0o600});
const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002',d='10000000-0000-4000-8000-000000000003';
const originalA=[{id:'a-first',track:'other',speaker:'受访者',tStartMs:2000,text:'关键访谈证据：下周继续讨论。'},{id:'a-second',track:'other',speaker:'受访者',tStartMs:8000,text:'这一段保持原样，用于检查单段修改范围。'}];
function seed(id,title,offset,turns,dictation){
 const dir=join(support,'sessions',id);mkdirSync(dir,{recursive:true});const startedAt=new Date(Date.now()-offset*3600000).toISOString();
 const doc={schema_version:1,id,title,startedAt,endedAt:startedAt,durationSec:30,status:'complete',autoDiarize:false,audio:{sampleRate:16000,channels:1,codec:'pcm_s16le'},tracks:{microphone:false,system:!dictation},jobs:{live:dictation?'done':'idle',refined:{status:dictation?'idle':'done',current:dictation?null:'refined-v1.json'},speakers:{status:dictation?'idle':'done',current:null}},...(dictation?{kind:'dictation',dictation}:{})};
 writeFileSync(join(dir,'session.json'),JSON.stringify(doc),{mode:0o600});
 if(!dictation){
  writeFileSync(join(dir,'refined-v1.json'),JSON.stringify({turns}),{mode:0o600});
  const wav=Buffer.alloc(44+30*32000);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);writeFileSync(join(dir,'system.wav'),wav,{mode:0o600});
 }
}
seed(a,'集成验收 · 采访',1,originalA);seed(b,'另一场独立会议',2,[{id:'b-first',track:'other',speaker:'其他人',tStartMs:4000,text:'另一场会议的独立正文。'}]);
seed(d,'语音输入合成示例',3,[],{text:'语音输入合成示例。',rawText:'嗯，语音输入合成示例。',asrModel:'qwen-audio-3.0-asr-flash-streaming'});
async function runApp(config){
 const {app,BrowserWindow,session,globalShortcut}=await import('electron');
 const fs=await import('node:fs');const{join}=await import('node:path');const{pathToFileURL}=await import('node:url');const{createHash}=await import('node:crypto');const assert=(await import('node:assert/strict')).default;
 app.setPath('appData',config.appData);app.setPath('userData',join(config.temp,'userData'));app.setPath('sessionData',join(config.temp,'sessionData'));
 // Reproduce the packaged resources location without changing the shared Electron distribution.
 Object.defineProperty(process,'resourcesPath',{value:join(config.temp,'resources')});
 const requests=[];const protect=s=>{s.webRequest.onBeforeRequest((details,cb)=>{const allowed=details.url.startsWith('file://'+config.workspace+'/out/renderer/')||details.url.startsWith('earshot-audio://');if(!allowed)requests.push(details.url);cb({cancel:!allowed});});};
 app.on('session-created',protect);
 const windows=[];app.on('browser-window-created',(_event,window)=>windows.push(window));
 const results=[],shots=[],screenshotChecks=[];let window;const timer=setTimeout(()=>{fs.writeFileSync(join(config.evidence,'timeout.json'),JSON.stringify({results,windows:windows.map(w=>({destroyed:w.isDestroyed(),url:w.isDestroyed()?'':w.webContents.getURL()}))},null,2));app.exit(1);},60000);
 const check=(condition,label)=>{assert.ok(condition,label);results.push({pass:true,assertion:label});};
 // Dynamic import happens after all isolation paths are set and before app readiness.
 await import(pathToFileURL(config.main).href);
 app.whenReady().then(async()=>{
  try{
   protect(session.defaultSession);
   for(let n=0;n<150;n++){window=windows.find(w=>!w.isDestroyed()&&w.webContents.getURL()===pathToFileURL(join(config.workspace,'out/renderer/index.html')).href);if(window)break;await new Promise(r=>setTimeout(r,30));}
   assert.ok(window,'real main created the library');
   const run=async code=>{try{return await window.webContents.executeJavaScript(code,true);}catch(error){throw Error(String(error)+'; app DOM action: '+code.slice(0,220));}};
   const until=async code=>{for(let n=0;n<160;n++){if(await run(code))return;await new Promise(r=>setTimeout(r,35));}throw Error('Actual-app wait expired: '+code);};
   const snap=()=>run('window.earshot.snapshot()');
   const input=async(selector,value)=>{await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Input missing');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await new Promise(r=>setTimeout(r,30));};
   const click=async text=>{await run(`(()=>{const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Button missing');b.click();})()`);await new Promise(r=>setTimeout(r,40));};
   const paint=async()=>{
    window.webContents.invalidate();
    await run(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Compositor animation frame timed out')),3000);requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve(true);}));})`);
    await new Promise(r=>setTimeout(r,180));
   };
   const visible=async selector=>run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();let area={left:0,top:0,right:innerWidth,bottom:innerHeight};for(let p=e.parentElement;p;p=p.parentElement){const c=getComputedStyle(p),b=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(c.overflowY)){area.top=Math.max(area.top,b.top);area.bottom=Math.min(area.bottom,b.bottom);}if(/auto|scroll|hidden|clip/.test(c.overflowX)){area.left=Math.max(area.left,b.left);area.right=Math.min(area.right,b.right);}}const c=getComputedStyle(e);return{selector:${JSON.stringify(selector)},text:e.textContent.trim().slice(0,500),checked:e.getAttribute('aria-checked'),bounds:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},clip:area,visible:c.visibility!=='hidden'&&c.display!=='none'&&r.width>0&&r.height>0&&r.left>=area.left-1&&r.right<=area.right+1&&r.top>=area.top-1&&r.bottom<=area.bottom+1};})()`);
   const reveal=async(selector,block='center')=>{
    await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Screenshot target missing');e.scrollIntoView({block:${JSON.stringify(block)},behavior:'instant'});})()`);
    await paint();
   };
   const shot=async(name,required=[])=>{
    await paint();
    const checks=[];for(const selector of required){const details=await visible(selector);assert.ok(details?.visible,'Screenshot target must be fully visible: '+name+' '+JSON.stringify(details));checks.push(details);}
    // Prime capture after scrolling: a hidden/occluded macOS window can retain an older compositor frame.
    await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    await paint();
    const image=await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});const path=join(config.evidence,name+'.png');fs.writeFileSync(path,image.toPNG());shots.push(path);screenshotChecks.push({path,viewport:await run('({width:innerWidth,height:innerHeight})'),targets:checks});
   };
   await until(`Boolean(window.earshot&&document.querySelector('.slist'))`);
   let state=await snap();check(state.sessions.length===3&&!state.hasApiKey&&state.selectedId===config.a,'real preload snapshot contains only three isolated fixture sessions and no key');
   check(state.shortcuts?.prefs.enabled===false&&state.shortcuts.prefs.meeting==='Control+Alt+Shift+F20','isolated shortcut preferences loaded; deployed shortcuts untouched');
   check(app.getPath('appData')===config.appData&&app.getPath('userData')===join(config.temp,'userData'),'main process appData and userData resolve only to isolated test directories');
   window.setSize(1180,800);await new Promise(r=>setTimeout(r,120));
   await input('input[type="search"]','关键访谈证据');await until(`document.querySelector('.search-hit')?.textContent.includes('关键访谈证据')`);await run(`document.querySelector('.search-hit').click()`);await until(`document.querySelector('article[data-turn-id="a-first"]')!==null`);
   state=await snap();check(state.selectedId===config.a,'actual search through IPC selects source recording');
   await run(`document.querySelector('article[data-turn-id="a-first"] .seek-time').click()`);await until(`window.earshot.snapshot().then(s=>s.playback?.sessionId===${JSON.stringify(config.a)}&&s.playback.status==='playing'&&s.playback.positionSec>=2)`);
   check((await snap()).playback.positionSec<5,'timestamp click starts real media playback near requested two-second offset');
   await click('暂停');await until(`window.earshot.snapshot().then(s=>s.playback?.status==='paused')`);
   const pausedPosition=(await snap()).playback.positionSec;
   await run(`(()=>{const select=document.querySelector('select[aria-label="播放速度"]');select.value='1.5';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(`window.earshot.snapshot().then(s=>s.playback?.rate===1.5)`);
   state=await snap();check(state.playback.status==='paused'&&Math.abs(state.playback.positionSec-pausedPosition)<0.01,'real rate IPC and Chromium acknowledgement preserve paused position');
   await run(`document.querySelector('article[data-turn-id="a-first"] .turn-edit-button').click()`);await until(`document.querySelector('.transcript-editor')!==null`);
   await input('.transcript-editor input','改正后的说话人');await input('.transcript-editor textarea','修正后的关键访谈证据。');await click('保存修改');await until(`document.querySelector('article[data-turn-id="a-first"] .t-text')?.textContent==='修正后的关键访谈证据。'`);
   state=await snap();check(state.selected.turns[0].speaker==='改正后的说话人'&&state.selected.turns[1].text===config.originalA[1].text&&state.selected.turns[1].speaker===config.originalA[1].speaker,'real correction persists only selected turn without changing adjacent speaker or text');
   const original=JSON.parse(fs.readFileSync(join(config.support,'sessions',config.a,'refined-v1.json'),'utf8'));check(JSON.stringify(original.turns)===JSON.stringify(config.originalA),'source refined artifact remains byte-content-equivalent after correction');
   check(fs.existsSync(join(config.support,'sessions',config.a,'corrections.json')),'correction sidecar was written by actual main process');
   await run(`document.querySelector('article[data-turn-id="a-first"] .turn-edit-button').click()`);await until(`document.querySelector('.transcript-original')!==null`);await run(`document.querySelector('.transcript-original').open=true`);await reveal('.transcript-editor');await until(`document.querySelector('.transcript-original').open===true`);await shot('actual-correction-original',['.transcript-editor input','.transcript-editor textarea','.transcript-original p']);
   check((await visible('.transcript-original p')).text.includes(config.originalA[0].text),'expanded original text is actually inside screenshot viewport');
   await click('撤销上次修改');await until(`document.querySelector('article[data-turn-id="a-first"] .t-text')?.textContent===${JSON.stringify(config.originalA[0].text)}`);
   state=await snap();check(state.selected.turns[0].speaker===config.originalA[0].speaker&&!state.selected.turns[0].correction.edited,'real undo restores original text and speaker in snapshot and UI');
   await run(`document.querySelector('.bookmark-strip').open=true`);await until(`document.querySelector('.bookmark-add input')!==null`);await input('.bookmark-add input','集成验收标记');await run(`document.querySelector('.bookmark-add button').click()`);await until(`document.querySelector('.bookmark-seek')?.textContent.includes('集成验收标记')`);
   const bookmark=(await snap()).selected.bookmarks[0];check(bookmark.label==='集成验收标记'&&Math.abs(bookmark.tStartMs-pausedPosition*1000)<1,'bookmark records current paused audio position through actual main');
   check(JSON.parse(fs.readFileSync(join(config.support,'sessions',config.a,'bookmarks.json'),'utf8')).items.length===1,'bookmark is persisted in isolated session file');
   await until(`document.querySelector('.transcript-search-results')?.getAttribute('aria-busy')==='false'`);
   await shot('actual-library-desktop');
   window.setSize(800,700);await new Promise(r=>setTimeout(r,160));await shot('actual-library-compact');
   check(await run(`document.documentElement.scrollWidth<=document.documentElement.clientWidth`),'actual library fits minimum supported window width without horizontal page overflow');
   window.setSize(1180,800);await new Promise(r=>setTimeout(r,120));
   await run(`document.querySelector('[aria-label="删除标记 集成验收标记"]').click()`);await until(`window.earshot.snapshot().then(s=>s.selected.bookmarks.length===0)`);check(JSON.parse(fs.readFileSync(join(config.support,'sessions',config.a,'bookmarks.json'),'utf8')).items.length===0,'delete bookmark updates disk and live UI');
   await click('结束回听');await until(`window.earshot.snapshot().then(s=>s.playback===null)`);
   await run(`document.querySelector('.sl-foot button').click()`);await until(`document.querySelector('#personal-hotwords')!==null&&document.querySelector('#usage-heading')!==null`);
   await input('#personal-hotwords','采访专有词');await click('保存热词');await until(`document.querySelector('.hotword-status')?.textContent.includes('密钥')`);
   check((await run('window.earshot.hotwordStatus()')).words[0]==='采访专有词','settings saves real local hotword without pretending cloud synchronization succeeded');
   check(JSON.parse(fs.readFileSync(join(config.support,'hotwords.json'),'utf8')).words[0]==='采访专有词','local hotword file contains only entered synthetic term');
   const usage=await run('window.earshot.usageSummary()');check(usage.requests===0&&usage.estimatedCny===0&&usage.balanceCny===null&&usage.actualBilling==='unavailable','real usage API reports no model calls and unavailable account balance');
   await until(`document.querySelector('.usage-overview dd')?.textContent.includes('0.00')`);
   await reveal('[aria-labelledby="usage-heading"]');await shot('actual-settings-usage',['#usage-heading','.usage-overview','.usage-balance']);
   check((await visible('.usage-overview')).visible&&(await visible('.usage-balance')).visible,'usage amounts and unavailable balance are simultaneously visible in screenshot');
   await reveal('#personal-hotwords');await shot('actual-settings-hotwords',['#personal-hotwords','.hotword-status']);
   await reveal('[aria-label="自动填入"]');
   const automatic=await visible('[aria-label="自动填入"]');check(automatic.visible&&automatic.checked==='true'&&(await snap()).shortcuts.prefs.delivery==='direct','automatic insertion matches persisted direct mode in actual settings');
   check(await run(`document.querySelector('[aria-label="微信兼容输入"]')===null`),'obsolete app-specific compatibility toggle is absent');
   await shot('actual-settings-auto-insert',['[aria-label="自动填入"]']);
   await reveal('#personal-hotwords');
   window.setSize(800,700);await new Promise(r=>setTimeout(r,160));await shot('actual-settings-compact');
   check(await run(`document.documentElement.scrollWidth<=document.documentElement.clientWidth`),'actual settings fit minimum supported window width without horizontal page overflow');
   window.close();await new Promise(r=>setTimeout(r,100));check(!window.isDestroyed()&&!window.isVisible(),'closing actual library hides it while main process remains alive');
   check((await snap()).sessions.length===3,'real preload IPC still responds after library window close');
   await run('window.earshot.showLibrary()');await new Promise(r=>setTimeout(r,120));check(!window.isDestroyed()&&window.isVisible(),'actual showLibrary IPC reopens resident window');
   check(requests.length===0,'no renderer network request occurred during local integration');
   check(!fs.existsSync(join(config.support,'key')),'integration created no API-key file');
   const finalMainSha=createHash('sha256').update(fs.readFileSync(config.main)).digest('hex');check(finalMainSha===config.mainSha256,'built main checksum remained fixed throughout acceptance');
   fs.writeFileSync(join(config.evidence,'result.json'),JSON.stringify({pass:true,scope:'real built main + preload + React renderer with isolated synthetic sessions; native TCC, external-app cursor, visible UI and picker acceptance not exercised',mainSha256:config.mainSha256,sourceSha256:config.sourceSha256,electron:process.versions.electron,chromium:process.versions.chrome,isolatedAppData:config.appData,isolatedUserData:app.getPath('userData'),results,screenshots:shots,screenshotChecks},null,2));
   console.log(JSON.stringify({pass:true,assertions:results.length,evidence:config.evidence}));clearTimeout(timer);globalShortcut.unregisterAll();app.exit(0);
  }catch(error){fs.writeFileSync(join(config.evidence,'result.json'),JSON.stringify({pass:false,error:String(error),mainSha256:config.mainSha256,results,screenshots:shots,screenshotChecks},null,2));console.error(error);clearTimeout(timer);globalShortcut.unregisterAll();app.exit(1);}
 });
}
writeFileSync(join(temp,'runner.mjs'),`(${runApp.toString()})(${JSON.stringify({workspace,temp,evidence,main,mainSha256,sourceSha256,appData,support,a,b,d,originalA})});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
const run=spawnSync(electron,[join(temp,'runner.mjs')],{encoding:'utf8',env,timeout:75000});writeFileSync(join(evidence,'app.log'),(run.stdout??'')+(run.stderr??''));process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');
let pass=false;try{pass=JSON.parse(readFileSync(join(evidence,'result.json'),'utf8')).pass===true;}catch{}
console.log('Evidence: '+evidence);if(run.error)console.error(run.error);process.exitCode=run.status===0&&pass?0:1;
