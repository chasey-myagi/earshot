import assert from 'node:assert/strict';
import test from 'node:test';
import {pasteFixture} from './paste-target-fixture.mjs';
import {createDictationController} from './controller.ts';

test('an opaque input remains eligible for one paste without application-specific consent flags',async()=>{
 const h=pasteFixture({editable:null});assert.equal((await h.insert('跨应用🙂\n整段文字')).kind,'posted-unconfirmed');assert.equal(h.counts().attempts,1);assert.equal(h.counts().finishes,1);h.target.release();
});
test('opaque inputs still reject known target changes and protected input',async()=>{
 for(const patch of [{sameContext:false},{secure:true}]){const h=pasteFixture({editable:null});Object.assign(h.state,patch);assert.equal((await h.insert()).kind,'not-posted');assert.equal(h.counts().attempts,0);h.target.release();}
});
test('controller keeps an opaque result without claiming success or offering a retry',async()=>{
 let attempts=0;const states=[];
 const controller=createDictationController({preflight:()=>null,preview:()=>false,
 target:()=>({insert:()=>{attempts++;return {kind:'posted-unconfirmed'};},release(){}}),
 capture:async({pcm})=>{pcm(Buffer.alloc(16000));return{stop:async()=>{}};},transcribe:async()=> '保留我的文字',changed:s=>states.push(s)});
 try{await controller.begin();await controller.end();assert.equal(controller.snapshot().resultKind,'delivery-unconfirmed');assert.equal(controller.snapshot().text,'保留我的文字');assert.equal(states.some(s=>s.phase==='success'),false);assert.equal((await controller.insert()).ok,false);assert.equal(attempts,1);}finally{await controller.cancel();}
});
test('history persistence failure retains raw recognition and prevents automatic input',async()=>{
 let attempts=0;
 const controller=createDictationController({preflight:()=>null,preview:()=>false,target:()=>({insert:()=>{attempts++;return{kind:'verified'};},release(){}}),
 capture:async({pcm})=>{pcm(Buffer.alloc(16000));return{stop:async()=>{}};},transcribe:async()=> '仍然可复制的原文',complete:async()=>{throw Error('disk full');},changed(){}});
 try{await controller.begin();await controller.end();assert.equal(controller.snapshot().resultKind,'save-failed');assert.equal(controller.snapshot().text,'仍然可复制的原文');assert.equal(attempts,0);assert.equal(controller.snapshot().retryable,false);}finally{await controller.cancel();}
});
