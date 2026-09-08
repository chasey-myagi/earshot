// Real React components in isolated offscreen Chromium with a synthetic API.
// This proves DOM behavior; it does not prove main IPC, macOS TCC, visible focus or real cloud calls.
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';
const workspace = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'earshot-upgrade-ui-'));
const evidence = resolve(process.env.EARSHOT_UI_EVIDENCE ?? '../earshot-release-evidence/2026-09-08-full-upgrade', `component-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(evidence, { recursive: true });
const component = name => JSON.stringify(resolve('src/renderer', name));
const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {HotwordSettings} from ${component('HotwordSettings.tsx')};
import {TranscriptEditor} from ${component('TranscriptEditor.tsx')};
import {SearchPanel} from ${component('SearchPanel.tsx')};
import {Bookmarks} from ${component('Bookmarks.tsx')};
import {PlaybackBar} from ${component('PlaybackBar.tsx')};
import ${component('styles.css')};
const clone=value=>structuredClone(value);
const events=new Set(),requests=[];let holding=false;
let status={words:['Earshot'],updatedAt:1,sync:'ready',message:'原账户词表已就绪',models:[{model:'fun-asr',label:'录音文件转写',supported:true,ready:true}]};
const logs=[];
const load=()=>new Promise(resolve=>{const request={resolve,value:clone(status)};requests.push(request);if(!holding)resolve(request.value);});
const subscribe=fn=>{events.add(fn);return()=>events.delete(fn);};
const hotSave=async text=>{logs.push({action:'hot-save',text});status={...status,words:text.split('\\n'),sync:'ready',message:'示例词表已保存',models:status.models.map(model=>({...model,ready:true}))};return clone(status);};
const hotSync=async()=>{logs.push({action:'hot-sync'});status={...status,sync:'ready',message:'示例同步已完成',models:status.models.map(model=>({...model,ready:true}))};return clone(status);};
let setTurnExternal,setBookmarksExternal,setPlaybackExternal;
const initialTurn={id:'one',track:'other',speaker:'王明',text:'原始转写正文',tStartMs:12000,correction:{revision:'r0',originalText:'原始转写正文',originalSpeaker:'王明',edited:false,speakerOverridden:false,canUndo:false}};
function App(){
 const [turn,setTurn]=useState(initialTurn),[editor,setEditor]=useState(true),[items,setItems]=useState([]),[playback,setPlayback]=useState({sessionId:'session',title:'示例会议',status:'paused',positionSec:2,durationSec:30,rate:1});
 setTurnExternal=setTurn;setBookmarksExternal=setItems;setPlaybackExternal=setPlayback;
 window.earshot={seekPlayback:async input=>{logs.push({action:'seek',...input});setPlayback(value=>({...value,positionSec:input.positionSec}));return{ok:true};},setPlaybackRate:async rate=>{logs.push({action:'rate',rate});setPlayback(value=>({...value,rate}));return{ok:true};},pausePlayback:async()=>({ok:true}),playSession:async()=>({ok:true}),stopPlayback:async()=>({ok:true})};
 return <main style={{padding:24,maxWidth:1100,margin:'0 auto'}}><h1>组件验收 · 合成数据</h1><p>隔离 Chromium，非完整应用或真实账户。</p>
 <HotwordSettings load={load} save={hotSave} sync={hotSync} subscribe={subscribe}/>
 <section id="editor-fixture"><h3>单段纠错</h3>{editor?<TranscriptEditor sessionId="session" turn={turn} onClose={()=>setEditor(false)} onSave={async input=>{logs.push({action:'edit-save',...input});setTurn(value=>({...value,text:input.text,speaker:input.speaker,correction:{...value.correction,revision:'r1',edited:true,canUndo:true}}));return{ok:true};}} onUndo={async input=>{logs.push({action:'edit-undo',...input});setTurn(initialTurn);return{ok:true};}} onReset={async()=>({ok:true})}/>:<><p id="saved-turn">{turn.speaker}：{turn.text}</p><button onClick={()=>setEditor(true)}>重新编辑</button></>}</section>
 <SearchPanel search={async input=>{logs.push({action:'search',...input});return{ok:true,hits:input.query.includes('查找')?[{sessionId:'session',sessionTitle:'示例会议',turnId:'one',tStartMs:12000,snippet:'查找命中的正文',speaker:'王明'}]:[],truncated:false};}} onSelect={hit=>logs.push({action:'search-select',...hit})}/>
 <Bookmarks sessionId="session" items={items} positionMs={12000} onAdd={async input=>{logs.push({action:'bookmark-add',...input});setItems(value=>[...value,{id:'bookmark',tStartMs:input.tStartMs,label:input.label}]);return{ok:true};}} onDelete={async input=>{logs.push({action:'bookmark-delete',...input});setItems([]);return{ok:true};}} onSeek={tStartMs=>logs.push({action:'bookmark-seek',tStartMs})}/>
 <PlaybackBar playback={playback} blocked={false} onOpen={()=>{}}/>
 </main>;
}
window.qa={logs,changeHot(sync,words=undefined,hold=false){holding=hold;status={...status,sync,words:words??status.words,message:sync==='ready'?'新账户词表已就绪':sync==='error'?'新密钥需要重新同步':'新账户词表待同步',models:status.models.map(model=>({...model,ready:sync==='ready'}))};for(const fn of events)fn();holding=false;return requests.length-1;},release(index){requests[index].resolve(requests[index].value);},setPlayback: value=>setPlaybackExternal(current=>({...current,...value})),setTurn:value=>setTurnExternal(value)};
createRoot(document.getElementById('root')).render(<App/>);
`;
await build({ stdin: { contents: fixture, resolveDir: workspace, sourcefile: 'component-fixture.jsx', loader: 'jsx' }, outfile: join(temp, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
writeFileSync(join(temp,'index.html'), '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:; font-src \'self\'; connect-src \'none\'"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
async function runElectron(config) {
 const {app,BrowserWindow,session}=await import('electron');
 const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');const assert=(await import('node:assert/strict')).default;
 app.setPath('userData',join(config.temp,'profile'));app.on('window-all-closed',()=>{});
 app.whenReady().then(async()=>{
  const results=[],shots=[];let window;
  const checked=(condition,message)=>{assert.ok(condition,message);results.push({pass:true,assertion:message});};
  try{
   const isolated=session.fromPartition('earshot-component-qa');isolated.setPermissionRequestHandler((_w,_p,cb)=>cb(false));isolated.setPermissionCheckHandler(()=>false);
   isolated.webRequest.onBeforeRequest((details,cb)=>cb({cancel:!details.url.startsWith('file://'+config.temp+'/')}));
   window=new BrowserWindow({show:false,width:1180,height:1500,webPreferences:{session:isolated,offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
   window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
   await window.loadFile(join(config.temp,'index.html'));
   const run=async code=>{try{return await window.webContents.executeJavaScript(code,true);}catch(error){throw Error(String(error)+'; DOM action: '+code.slice(0,240));}};
   const until=async(code)=>{for(let i=0;i<100;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,30));}throw Error('DOM wait expired: '+code);};
   const click=async(text)=>{await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);await new Promise(r=>setTimeout(r,40));};
   const input=async(selector,value)=>{await run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await new Promise(r=>setTimeout(r,30));};
   const shot=async(name)=>{const image=await window.webContents.capturePage();const path=join(config.evidence,name+'.png');writeFileSync(path,image.toPNG());shots.push(path);};
   await until(`document.querySelector('#personal-hotwords')?.value==='Earshot'`);
   checked(await run(`document.querySelector('.hotword-status').textContent.includes('原账户词表已就绪')`),'I1 initial ready status is rendered');
   checked(await run(`!Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='重试同步')`),'ready status has no retry action');
   await run(`qa.changeHot('pending')`);await until(`document.querySelector('.hotword-status').textContent.includes('新账户词表待同步')`);
   checked(await run(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='重试同步'&&!b.disabled)`),'key-change pending event refreshes mounted UI and enables retry');
   await run(`qa.changeHot('error')`);await until(`document.querySelector('.hotword-status').textContent.includes('新密钥需要重新同步')`);
   checked(await run(`document.querySelector('.hotword-models').textContent.includes('待同步')`),'new key error shows model as pending instead of stale ready');
   await shot('hotwords-key-changed');
   await input('#personal-hotwords','尚未保存的用户词');await run(`qa.changeHot('pending',['后端新词'])`);await until(`document.querySelector('.hotword-status').textContent.includes('新账户词表待同步')`);
   checked(await run(`document.querySelector('#personal-hotwords').value==='尚未保存的用户词'`),'background status refresh preserves unsaved draft');
   checked(await run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='重试同步').disabled`),'dirty draft disables retry until saved');
   await input('#personal-hotwords','后端新词');const old=await run(`qa.changeHot('error',['旧账户词'],true)`);await run(`qa.changeHot('ready',['新账户词'])`);await until(`document.querySelector('#personal-hotwords').value==='新账户词'`);await run(`qa.release(${old})`);await new Promise(r=>setTimeout(r,80));
   checked(await run(`document.querySelector('#personal-hotwords').value==='新账户词'&&document.querySelector('.hotword-status').textContent.includes('新账户词表已就绪')`),'late old load cannot overwrite newer account status or words');
   await run(`qa.changeHot('error')`);await until(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='重试同步')`);await click('重试同步');await until(`document.querySelector('.hotword-status').textContent.includes('示例同步已完成')`);
   checked(await run(`qa.logs.some(row=>row.action==='hot-sync')`),'retry button invokes sync callback and shows returned result');
   await input('#personal-hotwords','保存的新词');await click('保存热词');await until(`document.querySelector('.hotword-status').textContent.includes('示例词表已保存')`);
   checked(await run(`qa.logs.some(row=>row.action==='hot-save'&&row.text==='保存的新词')`),'save sends exact user draft');
   await input('#editor-fixture input','李华');await input('#editor-fixture textarea','修正后的正文');await click('保存修改');await until(`document.querySelector('#saved-turn')?.textContent==='李华：修正后的正文'`);
   checked(await run(`qa.logs.some(row=>row.action==='edit-save'&&row.sessionId==='session'&&row.turnId==='one'&&row.revision==='r0'&&row.text==='修正后的正文'&&row.speaker==='李华')`),'edit form sends bound session, turn, revision, text and speaker');
   await click('重新编辑');checked(await run(`document.querySelector('.transcript-original')?.textContent.includes('王明：原始转写正文')`),'edited form retains original text and speaker');await shot('turn-edit-original');await click('撤销上次修改');await until(`document.querySelector('#saved-turn')?.textContent==='王明：原始转写正文'`);
   checked(await run(`qa.logs.some(row=>row.action==='edit-undo'&&row.revision==='r1')`),'undo uses latest turn revision and displays restored content');
   await input('input[type="search"]','查找');await until(`document.querySelector('.search-hit')?.textContent.includes('查找命中的正文')`);await run(`document.querySelector('.search-hit').click()`);
   checked(await run(`qa.logs.some(row=>row.action==='search-select'&&row.sessionId==='session'&&row.turnId==='one'&&row.tStartMs===12000)`),'search result click preserves source session, turn and audio offset');
   await input('.bookmark-add input','要回听的地方');await click('标记 00:12');await until(`document.querySelector('.bookmark-seek')?.textContent.includes('要回听的地方')`);await run(`document.querySelector('.bookmark-seek').click()`);
   checked(await run(`qa.logs.some(row=>row.action==='bookmark-add'&&row.tStartMs===12000&&row.label==='要回听的地方')&&qa.logs.some(row=>row.action==='bookmark-seek'&&row.tStartMs===12000)`),'bookmark add and recall retain exact position and label');
   await run(`document.querySelector('[aria-label="后退 5 秒"]').click()`);await until(`qa.logs.some(row=>row.action==='seek'&&row.positionSec===0)`);
   checked(await run(`document.querySelector('.playback-toggle').textContent==='继续播放'`),'minus five clamps at zero and paused controls remain paused');
   await run(`qa.setPlayback({positionSec:28})`);await until(`document.querySelector('input[aria-label="播放位置"]').value==='28'`);await run(`document.querySelector('[aria-label="前进 5 秒"]').click()`);await until(`qa.logs.some(row=>row.action==='seek'&&row.positionSec===30)`);
   checked(true,'plus five clamps at audio duration');
   await run(`(()=>{const e=document.querySelector('select[aria-label="播放速度"]');e.value='1.5';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await until(`qa.logs.some(row=>row.action==='rate'&&row.rate===1.5)`);
   checked(await run(`document.querySelector('select[aria-label="播放速度"]').value==='1.5'&&document.querySelector('.playback-toggle').textContent==='继续播放'`),'speed select invokes rate API and keeps paused state');
   await shot('upgrade-components');
   checked(await run(`document.querySelector('main').scrollWidth<=document.documentElement.clientWidth`),'desktop component layout does not overflow horizontally');
   window.setSize(760,1600);await new Promise(r=>setTimeout(r,150));await shot('upgrade-components-compact');
   checked(await run(`document.querySelector('main').scrollWidth<=document.documentElement.clientWidth`),'compact component layout does not overflow horizontally');
   writeFileSync(join(config.evidence,'result.json'),JSON.stringify({pass:true,scope:'offscreen Chromium real React component integration with synthetic API; not full main IPC, visible UI or TCC acceptance',electron:process.versions.electron,chromium:process.versions.chrome,results,screenshots:shots},null,2));
   console.log(JSON.stringify({pass:true,assertions:results.length,evidence:config.evidence}));window.destroy();app.exit(0);
  }catch(error){writeFileSync(join(config.evidence,'result.json'),JSON.stringify({pass:false,error:String(error),results,screenshots:shots},null,2));console.error(error);if(window&&!window.isDestroyed())window.destroy();app.exit(1);}
 });
}
writeFileSync(join(temp,'runner.mjs'), `(${runElectron.toString()})(${JSON.stringify({temp,evidence})});`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const run=spawnSync(electron,[join(temp,'runner.mjs')],{encoding:'utf8',env,timeout:120000});process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');
let pass=false;try{pass=JSON.parse(readFileSync(join(evidence,'result.json'),'utf8')).pass===true;}catch{}
console.log('Evidence: '+evidence);if(run.error)console.error(run.error);process.exitCode=run.status===0&&pass?0:1;
