// Standalone Electron acceptance. Uses generated tones, a temporary profile, no keys or app installation.
// ffmpeg is used only to generate MP3/M4A QA fixtures; it is not an Earshot runtime dependency.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import electron from 'electron';

const root = mkdtempSync(join(tmpdir(), 'earshot-import-playback-qa-'));
const wav = Buffer.alloc(44 + 48000 * 2 * 2 * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < 96000; i++) {
  // Distinct stereo channels must average into audible mono without clipping.
  wav.writeInt16LE(Math.round(Math.sin(i / 48000 * Math.PI * 2 * 440) * 16000), 44 + i * 4);
  wav.writeInt16LE(Math.round(Math.sin(i / 48000 * Math.PI * 2 * 440) * 8000), 46 + i * 4);
}
writeFileSync(join(root, 'tone.wav'), wav);
for (const format of ['mp3', 'm4a']) {
  const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', join(root, 'tone.wav'), join(root, `tone.${format}`)], { encoding: 'utf8' });
  if (run.status !== 0) throw Error(`QA fixture encoder unavailable: ${run.stderr || run.error}`);
}
writeFileSync(join(root, 'broken.mp3'), 'not audio');
const longTone = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '1801', '-c:a', 'libmp3lame', '-b:a', '8k', join(root, 'too-long.mp3')], { encoding: 'utf8' });
if (longTone.status !== 0) throw Error('Could not generate duration-boundary QA fixture: ' + longTone.stderr);
await build({ entryPoints: [resolve('src/renderer/media-playback.ts')], outfile: join(root, 'media.js'), bundle: true, platform: 'browser', format: 'iife', globalName: 'EarshotMedia' });
const entry = `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { decodeWithChromium } from ${JSON.stringify(resolve('src/main/import-audio-electron.ts'))};
import { importAudio } from ${JSON.stringify(resolve('src/main/import-audio.ts'))};
const root = ${JSON.stringify(root)}, results=[];
app.on('window-all-closed',()=>{});
app.setPath('userData', join(root,'profile')); app.commandLine.appendSwitch('disable-crash-reporter');
app.whenReady().then(async()=>{
try {
  for (const ext of ['wav','mp3','m4a']) {
    const chunks=[]; let networkProbe;
    const decoded=await decodeWithChromium(join(root,'tone.'+ext),{
      signal:new AbortController().signal, onPCM:chunk=>chunks.push(Buffer.from(chunk)),
      onProgress:()=>{ if(!networkProbe) networkProbe=BrowserWindow.getAllWindows()[0].webContents.executeJavaScript("fetch('https://example.com').then(()=>false,()=>true)"); }
    });
    const pcm=Buffer.concat(chunks);
    assert.ok(decoded.durationSec>=1.95&&decoded.durationSec<=2.1,ext+' duration');
    assert.equal(pcm.length,decoded.durationSec*32000);
    let max=0;for(let i=0;i<pcm.length;i+=2)max=Math.max(max,Math.abs(pcm.readInt16LE(i)));
    assert.ok(max>9000&&max<15000,ext+' mono mix amplitude: '+max);
    assert.equal(await networkProbe,true,'decoder network is blocked');
    assert.equal(BrowserWindow.getAllWindows().length,0,'hidden decoder released');
    results.push({test:'Chromium decode '+ext,pass:true,durationSec:decoded.durationSec,pcmBytes:pcm.length,peak:max});
  }
  await assert.rejects(decodeWithChromium(join(root,'broken.mp3'),{signal:new AbortController().signal,onPCM:()=>assert.fail('corrupt output')}));
  assert.equal(BrowserWindow.getAllWindows().length,0);
  results.push({test:'corrupt codec failure releases decoder',pass:true});
  await assert.rejects(decodeWithChromium(join(root,'too-long.mp3'),{signal:new AbortController().signal,onPCM:()=>assert.fail('overlong audio must be rejected before PCM output')}),/30 分钟/);
  assert.equal(BrowserWindow.getAllWindows().length,0);
  results.push({test:'30 minute limit rejects actual 1801 second MP3 before decoding PCM',pass:true});
  const canceled=new AbortController();let committed=false;
  await assert.rejects(importAudio({sourcePath:join(root,'tone.m4a'),sessionsRoot:join(root,'cancel-sessions'),decode:decodeWithChromium,
    signal:canceled.signal,commit:()=>{committed=true;},onProgress:p=>{if(p.phase==='decoding'&&p.percent>0)canceled.abort();}}),/取消/);
  assert.equal(committed,false);assert.deepEqual(readdirSync(join(root,'cancel-sessions')),[]);assert.equal(BrowserWindow.getAllWindows().length,0);
  results.push({test:'cancel during Chromium transfer cleans staging and process',pass:true});
  let result;
  const imported=await importAudio({sourcePath:join(root,'tone.m4a'),sessionsRoot:join(root,'sessions'),decode:decodeWithChromium,commit:r=>{result=r;}});
  assert.equal(imported.id,result.id);assert.ok(readFileSync(join(root,'sessions',result.id,'system.wav')).length>64000);
  results.push({test:'real M4A import normalization and original preservation',pass:true});
  const host=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await host.loadURL('data:text/html,<title>Playback QA</title>');
  await host.webContents.executeJavaScript(readFileSync(join(root,'media.js'),'utf8'));
  const wavURL='data:audio/wav;base64,'+readFileSync(join(root,'sessions',result.id,'system.wav')).toString('base64');
  const playback=await host.webContents.executeJavaScript(\`(async()=>{
    const reports=[];let media;
    const player=EarshotMedia.createMediaPlayback({createAudio:()=>{media=new Audio();media.muted=true;return media;},report:r=>reports.push(r)});
    let id=0;
    const run=(action,extra={})=>player.command({token:'fixture',id:++id,action,...extra});
    await run('load',{url:\${JSON.stringify(wavURL)},rate:1.5,positionSec:0.3});
    const loaded=reports.at(-1);await run('pause');const position=media.currentTime;
    await run('rate',{rate:2});const changed=reports.at(-1);
    await run('seek',{positionSec:0});const sought=reports.at(-1);
    await run('stop');const stopped=reports.at(-1);
    return{loaded,changed,sought,stopped,position,preservesPitch:media.preservesPitch};
  })()\`);
  assert.equal(playback.loaded.status,'playing');assert.equal(playback.loaded.rate,1.5);
  assert.equal(playback.changed.status,'paused');assert.equal(playback.changed.rate,2);
  assert.equal(playback.changed.positionSec,playback.position);assert.equal(playback.preservesPitch,true);
  assert.equal(playback.sought.positionSec,0);assert.equal(playback.sought.status,'paused');assert.equal(playback.stopped.status,'idle');
  host.destroy();results.push({test:'real Chromium playback rate, paused seek, pitch and stop',pass:true,...playback});
  writeFileSync(join(root,'result.json'),JSON.stringify({pass:true,electron:process.versions.electron,chrome:process.versions.chrome,results},null,2));
  console.log(JSON.stringify({pass:true,evidence:join(root,'result.json'),tests:results.length}));
  app.exit(0);
}catch(error){console.error(error);writeFileSync(join(root,'result.json'),JSON.stringify({pass:false,error:String(error),results},null,2));app.exit(1);}
});
`;
await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'acceptance.mjs', loader: 'js' }, outfile: join(root, 'acceptance.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'] });
const qaEnv = { ...process.env }; delete qaEnv.ELECTRON_RUN_AS_NODE;
const run = spawnSync(electron, [join(root, 'acceptance.mjs')], { encoding: 'utf8', timeout: 180000, env: qaEnv });
process.stdout.write(run.stdout ?? '');process.stderr.write(run.stderr ?? '');
console.log(`Evidence: ${join(root,'result.json')}`);
if (run.error) console.error(run.error);
let passed = false; try { passed = JSON.parse(readFileSync(join(root,'result.json'),'utf8')).pass === true; } catch {}
process.exitCode = run.status === 0 && passed ? 0 : 1;
