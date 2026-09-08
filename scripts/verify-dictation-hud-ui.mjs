// Real DictationHUD in isolated offscreen Chromium. No microphone, credentials or network.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const temp = mkdtempSync(join(tmpdir(), 'earshot-dictation-hud-ui-'));
const evidence = resolve(process.env.EARSHOT_UI_EVIDENCE ?? '../earshot-release-evidence/2026-09-08-dictation-startup', `hud-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(evidence, { recursive: true });
const sourceFiles = ['src/renderer/Dictation.tsx', 'src/renderer/styles.css', 'src/main/windows/dictation.ts', 'scripts/verify-dictation-hud-ui.mjs'];
writeFileSync(join(evidence, 'source-manifest.json'), JSON.stringify(Object.fromEntries(sourceFiles.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])), null, 2));
const fixture = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {DictationHUD} from ${JSON.stringify(resolve('src/renderer/Dictation.tsx'))};
import ${JSON.stringify(resolve('src/renderer/styles.css'))};
const idle={phase:'idle',text:'',message:'',startedAt:null,level:0,retryable:false};
let listener;window.earshot={onDictation:fn=>{listener=fn;return()=>{listener=null}},dictationSnapshot:async()=>idle,
cancelDictation:async()=>{},copyDictation:async()=>({ok:false,error:'复制未完成，请再次尝试。'}),retryDictation:async()=>({ok:true}),insertDictation:async()=>{},showLibrary:async()=>{}};
window.qa={set:state=>listener({...idle,...state}),ready:()=>Boolean(listener)};
createRoot(document.getElementById('root')).render(<DictationHUD/>);`;
await build({ stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: 'dictation-fixture.jsx', loader: 'jsx' }, outfile: join(temp, 'fixture.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
writeFileSync(join(temp, 'index.html'), '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');

async function runner(config) {
  const { app, BrowserWindow, session, nativeTheme } = await import('electron');
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  app.setPath('userData', join(config.temp, 'profile'));
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const checks = [], layouts = []; let win;
  const check = (pass, name, assertion) => checks.push({ pass: Boolean(pass), name, assertion });
  try {
    const isolated = session.fromPartition('dictation-hud-ui');
    isolated.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.webRequest.onBeforeRequest((request, cb) => cb({ cancel: !request.url.startsWith('file://' + config.temp + '/') }));
    win = new BrowserWindow({ show: false, width: 380, height: 94, frame: false, transparent: true, hasShadow: false,
      webPreferences: { session: isolated, offscreen: true, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadFile(join(config.temp, 'index.html'));
    const run = code => win.webContents.executeJavaScript(code, true);
    const pause = () => new Promise(resolve => setTimeout(resolve, 60));
    const until = async code => { for (let i = 0; i < 100; i++) { if (await run(code)) return; await pause(); } throw Error('UI wait expired'); };
    await until('window.qa?.ready() && document.documentElement.classList.contains("dictation-surface")');
    const longText = '这是供界面验证使用的合成文字，结果很长时只能在结果区域内滚动。'.repeat(40);
    const cases = [
      { name: 'success', height: 94, state: { phase: 'success', message: '已填入输入框' }, buttons: [] },
      { name: 'preparing', height: 94, state: { phase: 'preparing', message: '麦克风准备中，请稍等…' }, hint: '正在准备收音', buttons: [] },
      { name: 'listening', height: 94, state: { phase: 'listening', message: '可以说话了', startedAt: Date.now() - 8000, level: .7 }, hint: '松开转文字 · Esc 取消', buttons: [] },
      { name: 'transcribing', height: 94, state: { phase: 'transcribing', message: '正在转成文字…' }, buttons: [] },
      { name: 'long-result', height: 220, state: { phase: 'result', resultKind: 'preview', message: '文字已准备好', text: longText }, buttons: ['复制文字', '插入原位置', '放弃'] },
      { name: 'unconfirmed-result', height: 220, state: { phase: 'result', resultKind: 'delivery-unconfirmed', message: '已发送输入请求，请检查输入框', text: longText }, buttons: ['复制文字', '放弃'] },
      { name: 'error', height: 220, state: { phase: 'error', message: '实时识别暂时无法连接，请检查网络后重试。', retryable: true }, buttons: ['重试识别', '放弃'] },
      { name: 'error-with-text', height: 220, state: { phase: 'error', message: '尚未填入：输入位置无法写入，请复制文字', text: longText }, buttons: ['复制文字', '放弃'] },
    ];
    for (const theme of ['light', 'dark']) for (const width of [380, 320]) for (const test of cases) {
      const name = `${width}x${test.height}-${theme}-${test.name}`;
      nativeTheme.themeSource = theme; win.setSize(width, test.height);
      await run(`qa.set(${JSON.stringify(test.state)})`);
      await until(`document.querySelector('.dictation-hud')?.classList.contains(${JSON.stringify('phase-' + test.state.phase)}) && document.querySelector('[role="status"]')?.textContent===${JSON.stringify(test.state.message)}`);
      await pause();
      const layout = await run(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}};
        const page=document.scrollingElement;page.scrollTop=100;page.scrollLeft=100;
        const hud=document.querySelector('.dictation-hud'),result=document.querySelector('.dictation-result');
        return {viewport:{width:innerWidth,height:innerHeight},page:{height:page.scrollHeight,width:page.scrollWidth,top:page.scrollTop,left:page.scrollLeft},hud:rect(hud),
          status:document.querySelector('[role="status"]').textContent,hint:document.querySelector('.dictation-status p').textContent,
          copy:[...hud.querySelectorAll('.dictation-status strong,.dictation-status p')].map(e=>{const range=document.createRange();range.selectNodeContents(e);return {box:rect(e),text:rect(range)}}),
          text:result?.textContent,buttons:[...hud.querySelectorAll('button')].map(b=>{const range=document.createRange();range.selectNodeContents(b);return {label:b.getAttribute('aria-label')||b.textContent,box:rect(b),text:rect(range)}})};})()`);
      layouts.push({ name, ...layout });
      const inside = (r, box = { left: 0, top: 0, right: width, bottom: test.height }) => r.width > 0 && r.height > 0 && r.left >= box.left - 1 && r.top >= box.top - 1 && r.right <= box.right + 1 && r.bottom <= box.bottom + 1;
      check(layout.viewport.width === width && layout.viewport.height === test.height, name, 'actual viewport matches the compact or expanded window size');
      check(layout.page.height <= test.height && layout.page.width <= width && layout.page.top === 0 && layout.page.left === 0, name, 'document has no overflow or detachable viewport scrollbar');
      check(inside(layout.hud), name, 'complete HUD fits inside viewport');
      const expected = ['关闭语音输入', ...test.buttons];
      check(layout.buttons.length === expected.length && expected.every(label => layout.buttons.some(b => b.label === label)), name, 'all state actions exist');
      check(layout.buttons.every(b => inside(b.box, layout.hud) && inside(b.box) && inside(b.text, b.box)), name, 'all action controls and their text remain visible inside HUD');
      check(layout.status === test.state.message && (!test.state.text || layout.text === test.state.text), name, 'status and complete synthetic result are retained');
      check(layout.copy.length === 2 && layout.copy.every(c => inside(c.box, layout.hud) && inside(c.text, c.box)) && (!test.hint || layout.hint === test.hint), name, 'status and phase-specific hint remain legible within HUD');
      if (test.state.text) {
        const scroll = await run(`(()=>{const r=document.querySelector('.dictation-result');r.scrollTop=r.scrollHeight;return {top:r.scrollTop,max:r.scrollHeight-r.clientHeight,pageTop:document.scrollingElement.scrollTop};})()`);
        check(scroll.max > 0 && scroll.top > 0 && Math.abs(scroll.top - scroll.max) <= 1 && scroll.pageTop === 0, name, 'long result scrolls to its end without scrolling the document');
        await run('document.querySelector(".dictation-result").scrollTop=0');
      }
      const screenshot = join(config.evidence, name + '.png');
      writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
      if (test.name === 'long-result') {
        await run('[...document.querySelectorAll(".dictation-actions button")].find(b=>b.textContent==="复制文字").click()');
        await until('Boolean(document.querySelector("[role=alert]"))');
        const errorFits = await run(`(()=>{const e=document.querySelector('[role=alert]'),h=document.querySelector('.dictation-hud');const a=e.getBoundingClientRect(),b=h.getBoundingClientRect();return e.textContent==='复制未完成，请再次尝试。' && a.height>0 && a.top>=b.top && a.bottom<=b.bottom && a.right<=b.right;})()`);
        check(errorFits, name, 'action failure remains visible within expanded HUD');
      }
    }
    const pass = checks.every(check => check.pass);
    writeFileSync(join(config.evidence, 'result.json'), JSON.stringify({ pass, checks, layouts, scope: 'Actual DictationHUD and stylesheet in isolated offscreen Chromium. Synthetic state/API; no native input, capture, Key, network, TCC or visible app.' }, null, 2));
    console.log(JSON.stringify({ pass, passed: checks.filter(c => c.pass).length, total: checks.length, failures: checks.filter(c => !c.pass), evidence: config.evidence }));
    win.destroy(); app.exit(pass ? 0 : 1);
  } catch (error) {
    writeFileSync(join(config.evidence, 'result.json'), JSON.stringify({ pass: false, error: String(error), checks, layouts }, null, 2));
    console.error(error); if (win && !win.isDestroyed()) win.destroy(); app.exit(1);
  }
}
writeFileSync(join(temp, 'runner.mjs'), `(${runner.toString()})(${JSON.stringify({ temp, evidence })});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [join(temp, 'runner.mjs')], { encoding: 'utf8', env, timeout: 60000 });
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
let pass = false; try { pass = JSON.parse(readFileSync(join(evidence, 'result.json'), 'utf8')).pass === true; } catch {}
if (result.error) console.error(result.error);
process.exitCode = result.status === 0 && pass ? 0 : 1;
