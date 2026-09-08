import assert from 'node:assert/strict';
import test from 'node:test';
import {pasteFixture} from './paste-target-fixture.mjs';

test('posted without text acknowledgement is unconfirmed and cannot be sent a second time',async()=>{
 const h=pasteFixture();assert.equal((await h.insert()).kind,'posted-unconfirmed');assert.equal((await h.insert()).kind,'not-posted');assert.equal(h.counts().attempts,1);h.target.release();
});
test('delayed text and caret updates can acknowledge one paste without retries',async()=>{
 const h=pasteFixture();h.onPaste(text=>{setTimeout(()=>{h.state.editable={value:`前｜${text}｜后`,range:{location:2,length:2}};},10);setTimeout(()=>{h.state.editable.range={location:2+text.length,length:0};},40);return 'posted';});
 assert.equal((await h.insert()).kind,'verified');assert.equal(h.counts().attempts,1);h.target.release();
});
test('partial replacement is unconfirmed and never repaired by another paste',async()=>{
 const h=pasteFixture();h.onPaste(text=>{h.deliver(text.slice(0,1));return 'posted';});
 assert.equal((await h.insert()).kind,'posted-unconfirmed');assert.equal(h.state.editable.value,'前｜识｜后');assert.equal(h.counts().attempts,1);h.target.release();
});
test('cancel after dispatch stops target reads but still restores the clipboard lease',async()=>{
 const h=pasteFixture();h.onPaste(()=>{h.signal.abort();h.target.release();return 'posted';});
 h.onRead(()=>assert.equal(h.counts().released,0,'never read freed AX objects'));
 assert.equal((await h.insert()).kind,'posted-unconfirmed');assert.equal(h.counts().finishes,1);
});
test('dispatch exceptions are not converted to safe-to-retry failures',async()=>{
 const h=pasteFixture();h.onPaste(()=>{throw Error('native dispatch interrupted');});
 assert.equal((await h.insert()).kind,'posted-unconfirmed');assert.equal(h.counts().finishes,1);assert.equal(h.counts().attempts,1);h.target.release();
});
test('restoration failure does not erase verified delivery but is returned for a persistent warning',async()=>{
 const h=pasteFixture();h.onPaste(text=>{h.deliver(text);return 'posted';});h.clipboard.finish=async()=>{throw Error('restore failed');};
 const result=await h.insert();assert.equal(result.kind,'verified');assert.match(result.warning,/剪贴板未能恢复/);h.target.release();
});
