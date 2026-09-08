import assert from 'node:assert/strict';
import test from 'node:test';
import {validSelection} from './input-target.ts';
import {pasteFixture} from './paste-target-fixture.mjs';

test('selection bounds use UTF-16 and reject malformed ranges',()=>{
 assert.equal(validSelection('前🙂后',{location:1,length:2}),true);
 for(const range of [{location:-1,length:1},{location:1.5,length:0},{location:0,length:9},{location:0,length:-1}])assert.equal(validSelection('abc',range),false);
});
test('one paste replaces the selected text and preserves both surrounding fragments',async()=>{
 const h=pasteFixture();h.onPaste(text=>{h.deliver(text);return 'posted';});
 assert.equal((await h.insert('很长的中文🙂👨‍👩‍👧‍👦，允许换行\n下一行。')).kind,'verified');
 assert.equal(h.state.editable.value,'前｜很长的中文🙂👨‍👩‍👧‍👦，允许换行\n下一行。｜后');
 assert.deepEqual(h.events,['claim','paste','finish']);assert.equal(h.counts().attempts,1);h.target.release();
});
test('known window, document, selection and secure-input changes prevent even a clipboard claim',async()=>{
 for(const patch of [{sameContext:false},{secure:true},{editable:{value:'用户改了',range:{location:0,length:0}}},{editable:{value:'前｜选区｜后',range:{location:0,length:0}}}]){
  const h=pasteFixture();Object.assign(h.state,patch);assert.equal((await h.insert()).kind,'not-posted');assert.equal(h.counts().claims,0);assert.equal(h.counts().attempts,0);h.target.release();
 }
});
test('physical keys may release within the bounded wait, while a held key never receives synthesized releases',async()=>{
 const h=pasteFixture({keysReleased:false});h.onPaste(text=>{h.deliver(text);return 'posted';});
 setTimeout(()=>h.state.keysReleased=true,20);assert.equal((await h.insert()).kind,'verified');h.target.release();
 const held=pasteFixture({keysReleased:false});assert.equal((await held.insert()).kind,'not-posted');assert.equal(held.counts().attempts,0);held.target.release();
});
test('target or clipboard changes during snapshot creation restore the lease and post nothing',async()=>{
 for(const changed of ['target','clipboard']){
  const h=pasteFixture();h.onClaim(()=>changed==='target'?h.state.sameContext=false:h.copyChanged());
  assert.equal((await h.insert()).kind,'not-posted');assert.equal(h.counts().attempts,0);assert.equal(h.counts().finishes,1);h.target.release();
 }
});
test('malformed UTF-16 and NUL are rejected before any clipboard mutation',async()=>{
 for(const text of ['a\ud800','\u0000','a'.repeat(65537)]){const h=pasteFixture();assert.equal((await h.insert(text)).kind,'not-posted');assert.equal(h.counts().claims,0);h.target.release();}
});
