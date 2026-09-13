// Real React UI with a synthetic bridge, isolated profile and all network blocked.
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';
const temp = mkdtempSync(join(tmpdir(), 'earshot-auto-title-ui-'));
const evidence = resolve(process.env.EARSHOT_UI_EVIDENCE ?? '../earshot-release-evidence/2026-09-09-auto-title', `auto-title-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(evidence, { recursive: true });
const fixture = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {Library} from ${JSON.stringify(resolve('src/renderer/Library.tsx'))};
import ${JSON.stringify(resolve('src/renderer/styles.css'))};
const make=(id,title)=>({id,title,titleSource:'default',titleRevision:0,kind:'recording',startedAt:'2026-09-09T02:00:00Z',endedAt:'2026-09-09T02:30:00Z',durationSec:1800,status:'complete',jobs:{live:'done',refined:'done',speakers:'done'},people:[],turns:[{id:'one',track:'you',speaker:'你',text:'确认产品评审的交付范围与下一步安排。',tStartMs:12000}]});
const sessions=[make('alpha','9月9日 10:00'),make('beta','9月9日 11:00')];
let state,update;const pending=[],calls=[];
function select(id){update(s=>({...s,selectedId:id,selected:s.sessions.find(v=>v.id===id),libraryRequest:(s.libraryRequest??0)+1}));}
function title(id,title,source='auto'){update(s=>{const sessions=s.sessions.map(row=>row.id===id?{...row,title,titleSource:source,titleRevision:row.titleRevision+1}:row);return {...s,sessions,selected:sessions.find(row=>row.id===s.selectedId)};});}
window.earshot={onChange:()=>()=>{},selectSession:async id=>select(id),searchTranscripts:async()=>({ok:true,hits:[],truncated:false}),setShortcutCapture:async()=>({ok:true}),
hotwordStatus:async()=>({words:[],updatedAt:null,sync:'empty',models:[]}),
usageSummary:async period=>({period,trackingSince:Date.now(),requests:0,audioSeconds:0,inputTokens:0,outputTokens:0,estimatedCny:0,unpricedRequests:0,localMeasuredRequests:0,unconfirmedRequests:0,rows:[],pricingDate:'2026-09-09',retentionDays:366,capped:false}),
setAutoTitle:on=>{calls.push(on);return new Promise(resolve=>pending.push({on,resolve}));},
renameSession:async input=>{title(input.sessionId,input.title,'manual');return {ok:true};}};
window.qa={calls,pending,select,title,settings:()=>update(s=>({...s,settingsRequest:(s.settingsRequest??0)+1})),
resolve(result){const req=pending.shift();if(!req)throw Error('No pending save');if(result.ok)update(s=>({...s,autoTitle:req.on}));req.resolve(result);}};
function App(){[state,update]=useState({hasApiKey:true,autoDiarize:true,autoTitle:false,permissions:{microphone:'granted',screen:'granted'},recording:null,capturePhase:'idle',playingSessionId:null,sessions,selectedId:'alpha',selected:sessions[0]});return <Library snap={state} refresh={async()=>{}}/>;}
createRoot(document.getElementById('root')).render(<App/>);
`;
await build({ stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: 'auto-title-fixture.jsx', loader: 'jsx' }, outfile: join(temp, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.png': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' } });
writeFileSync(join(temp, 'index.html'), `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'none'"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>`);
async function runElectron(config) {
  const { app, BrowserWindow, session, nativeTheme } = await import('electron');
  const { join } = await import('node:path'), { writeFileSync } = await import('node:fs');
  const assert = (await import('node:assert/strict')).default;
  app.setPath('userData', join(config.temp, 'profile')); app.on('window-all-closed', () => {});
  await app.whenReady(); const results = [], screenshots = []; let win;
  const check = (value, label) => { assert.ok(value, label); results.push({ pass: true, assertion: label }); };
  try {
    const isolated = session.fromPartition('auto-title-qa');
    isolated.setPermissionRequestHandler((_w, _p, cb) => cb(false)); isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith('file://' + config.temp + '/') }));
    win = new BrowserWindow({ show: false, width: 1180, height: 820, webPreferences: { session: isolated, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadFile(join(config.temp, 'index.html'));
    const run = code => win.webContents.executeJavaScript(code, true), pause = (ms = 30) => new Promise(r => setTimeout(r, ms));
    const until = async code => { for (let i = 0; i < 150; i++) { if (await run(code)) return; await pause(); } throw Error('Wait expired: ' + code); };
    const paint = () => run(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const shot = async name => {
      // Prime the compositor: an offscreen macOS window may return its previous frame once.
      await paint(); await win.webContents.capturePage(); await paint();
      const path = join(config.evidence, name + '.png');
      writeFileSync(path, (await win.webContents.capturePage()).toPNG()); screenshots.push(path);
    };
    const input = async (selector, value) => { await run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`); await pause(); };
    await until(`Boolean(document.querySelector('.session-title h2'))`);
    check(await run(`document.querySelectorAll('.is-renaming').length===0`), 'initial display has no title animation');
    for (const theme of ['dark', 'light']) {
      nativeTheme.themeSource = theme;
      await pause(90); await paint(); await win.webContents.capturePage();
      const newTitle = theme === 'dark' ? '录音库交付范围与排期' : '新版录音库体验评审';
      await run(`qa.title('alpha',${JSON.stringify(newTitle)})`);
      await until(`document.querySelectorAll('.is-renaming').length===2`);
      check(await run(`Array.from(document.querySelectorAll('.title-current')).filter(e=>e.textContent===${JSON.stringify(newTitle)}).length===2&&Array.from(document.querySelectorAll('.title-leaving')).every(e=>e.getAttribute('aria-hidden')==='true')`), theme + ' sidebar and detail expose the new title and hide the old title from accessibility');
      const animations = await run(`(()=>{const a=document.getAnimations().filter(a=>['title-arrive','title-depart'].includes(a.animationName));a.forEach(a=>{a.pause();a.currentTime=90;});return a.map(a=>({name:a.animationName,frames:a.effect.getKeyframes()}));})()`);
      check(animations.length === 4 && animations.every(a => a.frames.every(f => 'opacity' in f && 'transform' in f)), theme + ' title motion uses opacity and transform');
      await shot('replacement-' + theme);
      check(await run(`document.querySelectorAll('.is-renaming').length===2`), theme + ' replacement screenshot was captured while both title animations were active');
      await run(`document.getAnimations().forEach(a=>a.finish())`);
      await until(`document.querySelectorAll('.title-leaving').length===0`);
      check(await run(`document.querySelector('.session-title h2').textContent===${JSON.stringify(newTitle)}`), theme + ' final title contains only the generated name');
    }
    await run(`qa.title('alpha','手动确认的录音名称','manual')`); await pause();
    check(await run(`document.querySelectorAll('.is-renaming').length===0`), 'manual rename does not animate');
    await run(`qa.select('beta')`); await pause(); await run(`qa.select('alpha')`); await pause();
    check(await run(`document.querySelectorAll('.is-renaming').length===0`), 'switching sessions does not replay animation');
    await run(`document.querySelector('.session-title h2').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await until(`Boolean(document.querySelector('.session-title input'))`); await input('.session-title input', '正在输入的手动草稿');
    await run(`qa.title('alpha','后台到达的标题')`); await pause();
    check(await run(`document.querySelector('.session-title input').value==='正在输入的手动草稿'`), 'automatic snapshot updates leave an in-progress manual draft untouched');
    await run(`document.querySelector('.session-title input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`); await pause(300);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await run(`qa.title('alpha','减少动态效果的录音标题')`); await pause();
    check(await run(`matchMedia('(prefers-reduced-motion: reduce)').matches&&document.querySelectorAll('.is-renaming').length===0&&document.querySelector('.session-title h2').textContent==='减少动态效果的录音标题'`), 'reduced motion updates immediately with no outgoing copy or animation');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }); win.webContents.debugger.detach();
    await run(`qa.settings()`); await until(`Boolean(document.querySelector('[aria-label="自动生成录音标题"]'))`);
    const toggle = '[aria-label="自动生成录音标题"]';
    check(await run(`document.querySelector(${JSON.stringify(toggle)}).getAttribute('aria-checked')==='false'`), 'setting is off by default in the actual SettingsPane');
    await run(`document.querySelector(${JSON.stringify(toggle)}).click();document.querySelector(${JSON.stringify(toggle)}).click()`); await pause();
    check(await run(`qa.calls.length===1&&qa.calls[0]===true&&document.querySelector(${JSON.stringify(toggle)}).disabled&&document.querySelector(${JSON.stringify(toggle)}).getAttribute('aria-checked')==='false'`), 'toggle sends one save request and waits for persistence before showing enabled');
    await run(`qa.resolve({ok:false,error:'设置未保存，请重试'})`); await until(`Boolean(document.querySelector('[aria-labelledby="recording-heading"] [role="alert"]'))`);
    check(await run(`document.querySelector(${JSON.stringify(toggle)}).getAttribute('aria-checked')==='false'&&!document.querySelector(${JSON.stringify(toggle)}).disabled`), 'failed save keeps the switch off and permits retry');
    await run(`document.querySelector(${JSON.stringify(toggle)}).click();qa.resolve({ok:true})`); await until(`document.querySelector(${JSON.stringify(toggle)}).getAttribute('aria-checked')==='true'`);
    check(await run(`!document.querySelector('[aria-labelledby="recording-heading"] [role="alert"]')`), 'successful retry clears the local error');
    await run(`document.querySelector('.auto-title-note').open=true`);
    for (const theme of ['dark', 'light']) for (const width of [1180, 800]) {
      nativeTheme.themeSource = theme; win.setSize(width, 820); await pause(90);
      await run(`document.querySelector('[aria-labelledby="recording-heading"]').scrollIntoView({block:'center'})`); await pause(90);
      check(await run(`(()=>{const s=document.querySelector(${JSON.stringify(toggle)}).getBoundingClientRect(),r=document.querySelector('[aria-labelledby="recording-heading"]').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&s.left>=r.left&&s.right<=r.right&&s.top>=0&&s.bottom<=innerHeight;})()`), theme + ' ' + width + ' setting remains visible and aligned without horizontal overflow');
      await shot('setting-' + width + '-' + theme);
    }
    await run(`document.querySelector(${JSON.stringify(toggle)}).click();qa.resolve({ok:true})`); await until(`document.querySelector(${JSON.stringify(toggle)}).getAttribute('aria-checked')==='false'`);
    check(await run(`qa.calls.at(-1)===false`), 'setting can be disabled');
    writeFileSync(join(config.evidence, 'result.json'), JSON.stringify({ pass: true, scope: 'Isolated Chromium, real React components, synthetic bridge. No cloud or macOS capture validation.', results, screenshots }, null, 2));
    console.log(JSON.stringify({ pass: true, assertions: results.length, evidence: config.evidence })); win.destroy(); app.exit(0);
  } catch (error) {
    writeFileSync(join(config.evidence, 'result.json'), JSON.stringify({ pass: false, error: String(error), results, screenshots }, null, 2));
    console.error(error); if (win && !win.isDestroyed()) win.destroy(); app.exit(1);
  }
}
writeFileSync(join(temp, 'runner.mjs'), `(${runElectron.toString()})(${JSON.stringify({ temp, evidence })});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const run = spawnSync(electron, [join(temp, 'runner.mjs')], { encoding: 'utf8', env, timeout: 90000 });
process.stdout.write(run.stdout ?? ''); process.stderr.write(run.stderr ?? '');
let pass = false; try { pass = JSON.parse(readFileSync(join(evidence, 'result.json'), 'utf8')).pass === true; } catch {}
if (run.error) console.error(run.error); process.exitCode = run.status === 0 && pass ? 0 : 1;
