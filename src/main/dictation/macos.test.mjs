import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolve} from 'node:path';
import {sourceLoader} from '../../../scripts/test-source-loader.mjs';
import {nativeFixture} from './macos-fixture.mjs';
const {shortcutHeld}=sourceLoader(resolve('src/main/index.ts'),{})('./dictation/macos');
const signal=()=>new AbortController().signal;
const native={skip:process.platform!=='darwin'};

test('missing native module disables hold capability without crashing the app',native,()=>{
 const load=sourceLoader(resolve('src/main/index.ts'),{'node:module':{createRequire:()=>()=>{throw Error('missing binary');}}});
 assert.equal(load('./dictation/macos').createMacDictationBridge(),undefined);
});
test('hold detection accepts either modifier side and detects physical key release',()=>{
 const down=new Set([61,49]);assert.equal(shortcutHeld('Alt+Space',code=>down.has(code)),true);
 down.delete(49);assert.equal(shortcutHeld('Alt+Space',code=>down.has(code)),false);assert.equal(shortcutHeld('F20',code=>code===90),true);
});
test('target capture uses window geometry and performs no AX reads before HUD preparation',native,()=>{
 const f=nativeFixture(),target=f.bridge.captureTarget();assert.ok(target);assert.deepEqual(f.reads,[]);
 assert.equal(JSON.stringify(target.screenPoint),JSON.stringify({x:500,y:400}));target.release();f.checkReleased();
});
test('native paste allocates a single complete command chord and verifies a full Unicode/multiline replacement',native,async()=>{
 const f=nativeFixture(),target=f.capture();assert.ok(target);
 assert.equal((await target.insert('完整中文🙂\n多行文本',signal())).kind,'verified');assert.equal(f.state.value,'前🙂完整中文🙂\n多行文本后');
 assert.deepEqual(f.events.map(e=>[e.key,e.down,e.flags]),[[55,true,1n<<20n],[9,true,1n<<20n],[9,false,1n<<20n],[55,false,0n]]);
 assert.equal((await target.insert('不要重复',signal())).kind,'not-posted');assert.equal(f.events.length,4);target.release();f.checkReleased();
});
test('partial event allocation releases all allocated resources without posting',native,async()=>{
 for(const createFailAt of [1,2,3,4]){const f=nativeFixture({createFailAt}),target=f.capture();assert.equal((await target.insert('合成',signal())).kind,'not-posted');assert.equal(f.events.length,0);target.release();f.checkReleased();}
});
test('event dispatch exception still posts key-up cleanup and stays unconfirmed',native,async()=>{
 const f=nativeFixture({postThrow:true}),target=f.capture();assert.equal((await target.insert('合成',signal())).kind,'posted-unconfirmed');
 assert.deepEqual(f.events.map(e=>[e.key,e.down]),[[55,true],[9,true],[9,false],[55,false]]);target.release();f.checkReleased();
});
test('secure fields are never read and cannot reach clipboard claim or paste',native,async()=>{
 const f=nativeFixture({subrole:'AXSecureTextField'}),target=f.capture();assert.equal(f.reads.includes('AXValue'),false);
 assert.equal((await target.insert('合成',signal())).kind,'not-posted');assert.equal(f.counts().claims,0);target.release();f.checkReleased();
});
