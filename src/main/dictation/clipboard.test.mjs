import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { sourceLoader } from '../../../scripts/test-source-loader.mjs';
const load = sourceLoader(resolve('src/main/dictation/clipboard.ts'), {});
const { createClipboardLease } = load('./clipboard');
const { PASTE_MARKER, PasteboardWriteError } = load('./macos-pasteboard');
const copy = items => Array.from(items, entries => Array.from(entries, e => ({ type:e.type, data:Buffer.from(e.data) })));
const textItems = text => [[{ type:'public.utf8-plain-text', data:Buffer.from(text) }]];

function fixture() {
  let items = [...textItems('原来的文字'), [{ type:'public.file-url', data:Buffer.from('file:///tmp/synthetic.txt') }]], version = 7;
  const original = copy(items), snapshots = []; let writes = 0, beforeReplace, failedWrite = false;
  const port = {
    snapshot(cancelled = () => false) { if (cancelled()) throw Error('取消'); const snapshot={items:copy(items),changeCount:version};snapshots.push(snapshot);return snapshot; },
    changeCount: () => version,
    replace(next, expected, cancelled = () => false) {
      if (beforeReplace) { const fn=beforeReplace;beforeReplace=undefined;fn(); }
      if (cancelled()) throw Error('取消');
      if (version !== expected) return null;
      writes++;version++;items=[];
      if (failedWrite) { failedWrite=false;throw new PasteboardWriteError(version); }
      items=copy(next);return ++version;
    },
    owns(expected, marker) { return version===expected && items.some(entries=>entries.some(e=>e.type===PASTE_MARKER && e.data.toString()===marker)); },
  };
  const lease=createClipboardLease(port);
  return {lease, port, original, snapshots, current:()=>copy(items), writes:()=>writes,
    userCopy(text) { items=textItems(text);version++; }, beforeReplace(fn) { beforeReplace=fn; }, failWrite() { failedWrite=true; } };
}

test('temporary paste preserves every original item and format, then clears the in-memory snapshot', () => {
  const f=fixture(),id=f.lease.claim('中文🙂\n多行',()=>false);
  assert.equal(f.lease.owned(id),true);assert.equal(f.lease.finish(id),'restored');
  assert.deepEqual(f.current(),f.original);assert.equal(f.snapshots[0].items.length,0);
  assert.equal(f.lease.finish(id),'none');
});
test('a new user copy, including the same recognized text, is never replaced by the original', () => {
  for(const value of ['用户新复制','识别文字']) {
    const f=fixture(),id=f.lease.claim('识别文字',()=>false);f.userCopy(value);
    assert.equal(f.lease.finish(id),'superseded');assert.deepEqual(f.current(),textItems(value));
    assert.equal(f.writes(),1);assert.equal(f.snapshots[0].items.length,0);
  }
});
test('a new transaction settles the preceding lease before taking its original snapshot', () => {
  const f=fixture(),first=f.lease.claim('第一轮',()=>false),second=f.lease.claim('第二轮',()=>false);
  assert.equal(f.lease.finish(first),'none');assert.equal(f.lease.owned(second),true);
  f.lease.finish(second);assert.deepEqual(f.current(),f.original);
});
test('copy while snapshot is being prepared aborts claim without overwriting that copy', () => {
  const f=fixture();f.beforeReplace(()=>f.userCopy('新复制'));
  assert.throws(()=>f.lease.claim('识别文字',()=>false),/刚刚变化/);
  assert.deepEqual(f.current(),textItems('新复制'));assert.equal(f.writes(),0);
});
test('cancellation before mutation leaves the original untouched and erases the snapshot', () => {
  const f=fixture();let canceled=false;f.beforeReplace(()=>{canceled=true});
  assert.throws(()=>f.lease.claim('识别文字',()=>canceled));
  assert.deepEqual(f.current(),f.original);assert.equal(f.writes(),0);assert.equal(f.snapshots[0].items.length,0);
});
test('a failed first write restores its own empty clearContents version', () => {
  const f=fixture();f.failWrite();assert.throws(()=>f.lease.claim('识别文字',()=>false),/写入失败/);
  assert.deepEqual(f.current(),f.original);assert.equal(f.snapshots[0].items.length,0);
});
test('explicit copy settles an older temporary lease and keeps the user-requested result', () => {
  const f=fixture(),id=f.lease.claim('临时',()=>false);f.lease.copy('用户选的结果',()=>false);
  assert.equal(f.lease.finish(id),'none');assert.deepEqual(f.current(),textItems('用户选的结果'));
});

test('a failed restoration retains the original snapshot and only retries its owned empty version', () => {
 const f=fixture(),id=f.lease.claim('临时',()=>false);f.failWrite();assert.throws(()=>f.lease.finish(id),/写入失败/);
 assert.ok(f.snapshots[0].items.length>0);assert.equal(f.lease.finish(id),'restored');assert.deepEqual(f.current(),f.original);
});
test('a user copy after failed restoration supersedes the retained empty-version lease', () => {
 const f=fixture(),id=f.lease.claim('临时',()=>false);f.failWrite();assert.throws(()=>f.lease.finish(id));f.userCopy('稍后复制');
 assert.equal(f.lease.finish(id),'superseded');assert.deepEqual(f.current(),textItems('稍后复制'));
});
