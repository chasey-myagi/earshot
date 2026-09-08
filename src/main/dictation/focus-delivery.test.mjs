import assert from 'node:assert/strict';
import test from 'node:test';
import {createDictationController} from './controller.ts';
import {nativeFixture} from './macos-fixture.mjs';
const native={skip:process.platform!=='darwin'};

for(const delivery of ['noop','partial'])test(`controller never reports success for native paste ${delivery}`,native,async()=>{
 const f=nativeFixture({delivery}),states=[];
 const c=createDictationController({preflight:()=>null,preview:()=>false,target:()=>f.bridge.captureTarget(),capture:async({pcm})=>{pcm(Buffer.alloc(16000));return{stop:async()=>{}};},transcribe:async()=> '完整合成结果',changed:s=>states.push(s)});
 try{await c.begin();await c.end();assert.equal(c.snapshot().resultKind,'delivery-unconfirmed');assert.equal(c.snapshot().text,'完整合成结果');assert.equal(states.some(s=>s.phase==='success'),false);assert.equal(f.events.length,4);assert.equal((await c.insert()).ok,false);f.checkReleased();}finally{await c.cancel();}
});
test('a focus change after native dispatch cannot be called verified delivery',native,async()=>{
 const f=nativeFixture(),target=f.capture();f.state.onPost=e=>{if(e.key===9&&e.down)f.state.focus='other-field';};
 assert.equal((await target.insert('合成结果',new AbortController().signal)).kind,'posted-unconfirmed');
 assert.equal(f.state.value,'前🙂合成结果后');assert.equal(f.events.length,4);target.release();f.checkReleased();
});
