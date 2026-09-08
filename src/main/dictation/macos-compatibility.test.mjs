import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeFixture} from './macos-fixture.mjs';
const native={skip:process.platform!=='darwin'};
const signal=()=>new AbortController().signal;

test('generic opaque AX groups and unavailable AX editors still use one unconfirmed paste',native,async()=>{
 for(const patch of [{role:'AXGroup',subrole:'iOSContentGroup'},{role:'AXWebArea'},{focus:null}]){
  const f=nativeFixture(patch),target=f.capture();assert.ok(target);assert.equal((await target.insert('合成跨应用文字',signal())).kind,'posted-unconfirmed');
  assert.equal(f.events.length,4);target.release();f.checkReleased();
 }
});
test('missing accessibility or a window remains copy-only while physical hold detection is available',native,async()=>{
 for(const patch of [{trusted:false},{noWindow:true}]){
  const f=nativeFixture(patch),target=f.capture();assert.ok(target);f.state.held=new Set([58,49]);assert.equal(f.bridge.held('Alt+Space'),true);f.state.held.clear();
  assert.equal((await target.insert('合成',signal())).kind,'not-posted');assert.equal(f.events.length,0);target.release();f.checkReleased();
 }
});
test('PID, window, AX focus, selection and text changes prevent any native paste',native,async()=>{
 for(const patch of [{pid:8822},{windowId:99},{focus:'other-field'},{value:'已经改变'},{range:{location:0,length:0}},{secure:true}]){
  const f=nativeFixture(),target=f.capture();Object.assign(f.state,patch);assert.equal((await target.insert('合成',signal())).kind,'not-posted');assert.equal(f.events.length,0);target.release();f.checkReleased();
 }
});
test('late focus change during native event preparation prevents the command chord',native,async()=>{
 const f=nativeFixture(),target=f.capture();f.state.onFlags=()=>{f.state.focus='another-field'};
 assert.equal((await target.insert('合成',signal())).kind,'not-posted');assert.equal(f.events.length,0);target.release();f.checkReleased();
});
