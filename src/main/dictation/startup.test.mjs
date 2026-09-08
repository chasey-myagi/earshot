import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceLoader } from '../../../scripts/test-source-loader.mjs';
import { DEFAULT_SHORTCUTS } from '../../shared/dictation.ts';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{enabled=true}={}) {
 const root=mkdtempSync(join(tmpdir(),'earshot-dictation-startup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'shortcuts.json'),JSON.stringify({...DEFAULT_SHORTCUTS,enabled}));
 const handlers=new Map(),power=new EventEmitter();let warm=0,closed=0,stops=0,opens=0,pending,input;
 const entry=fileURLToPath(new URL('./runtime.ts',import.meta.url));
 const get=sourceLoader(entry,{electron:{clipboard:{},shell:{},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},powerMonitor:power,
 globalShortcut:{register:()=>true,unregister(){}},systemPreferences:{getMediaAccessStatus:()=> 'granted',isTrustedAccessibilityClient:()=>true}},
 '../capture/dictation':{prepareDictationCapture:()=>warm++,closePreparedDictationCapture:()=>closed++,startDictationCapture:arg=>{opens++;input=arg;return new Promise((resolve,reject)=>{pending={resolve:()=>resolve({stop:async()=>{stops++;}}),reject};arg.signal.addEventListener('abort',()=>reject(Error('cancel')));});}},
 '../windows/dictation':{createDictationWindow:()=>({prepare(){},show(){},close(){}})},'../providers/dictation-stream':{startDictationStream:()=>({send(){},finish:async()=> '文字'})}});
 const runtime=get('./runtime').createDictationRuntime({root,store:{saveDictation(){}},apiKey:()=> 'fixture-key',meetingBusy:()=>false,startMeeting:async()=>({ok:true}),showMeeting(){},stopPlayback:async()=>{},changed(){}});
 t.after(()=>runtime.close());runtime.register();
 return {runtime,power,counts:()=>({warm,closed,stops,opens}),resolve:()=>pending.resolve(),pcm:()=>input.pcm(Buffer.alloc(6400)),invoke:(name,arg)=>handlers.get(`app:${name}`)({},arg)};
}
test('enabled runtime preloads without capturing; disabling closes warm page and re-enabling warms again',async t=>{
 const h=fixture(t);assert.deepEqual(h.counts(),{warm:1,closed:0,stops:0,opens:0});
 assert.equal((await h.invoke('saveShortcuts',{...DEFAULT_SHORTCUTS,enabled:false})).ok,true);assert.deepEqual(h.counts(),{warm:1,closed:1,stops:0,opens:0});
 assert.equal((await h.invoke('saveShortcuts',DEFAULT_SHORTCUTS)).ok,true);assert.equal(h.counts().warm,2);assert.equal(h.counts().opens,0);
});
test('disabled runtime never preloads or captures',async t=>{
 const h=fixture(t,{enabled:false});assert.equal(h.counts().warm,0);assert.equal((await h.invoke('beginDictation')).ok,false);assert.equal(h.counts().opens,0);
});
test('normal capture disposal warms next page; closing runtime disposes active capture without rewarming',async t=>{
 const h=fixture(t);let begin=h.invoke('beginDictation');await tick();h.pcm();h.resolve();await begin;await h.invoke('endDictation');assert.equal(h.counts().stops,1);assert.equal(h.counts().warm,2);
 begin=h.invoke('beginDictation');await tick();h.resolve();await begin;h.runtime.close();await tick();assert.equal(h.counts().stops,2);assert.equal(h.counts().warm,2);
});
test('close during delayed capture aborts and never rewarms after close',async t=>{
 const h=fixture(t);const begin=h.invoke('beginDictation');await tick();h.runtime.close();await begin;assert.equal(h.counts().warm,1);assert.equal(h.runtime.snapshot().phase,'idle');assert.equal(h.counts().opens,1);
});
test('screen lock aborts pending capture and a subsequent request can use a fresh page',async t=>{
 const h=fixture(t);const begin=h.invoke('beginDictation');await tick();h.power.emit('lock-screen');await begin;assert.equal(h.runtime.snapshot().phase,'idle');assert.equal(h.counts().warm,2);
 const next=h.invoke('beginDictation');await tick();h.resolve();await next;await h.invoke('cancelDictation');assert.equal(h.counts().stops,1);
});
