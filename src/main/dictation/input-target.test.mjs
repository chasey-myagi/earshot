import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protectInputTarget } from './input-target.ts';

function fixture() {
  let current = { value: '前🙂中后', range: { location: 3, length: 1 } }, focus = true, releases = 0;
  const writes = [];
  const target = protectInputTarget({ read: () => current, focused: () => focus,
    replace: (before, text) => { writes.push(before.value.slice(0, before.range.location) + text + before.value.slice(before.range.location + before.range.length)); return true; },
    release: () => releases++,
  });
  return { target, writes, edit: value => current = value, blur: () => focus = false, releases: () => releases };
}
test('captured selection uses UTF-16 offsets and is inserted at most once', () => {
  const h = fixture(); assert.equal(h.target.insert('回填😀'), true);
  assert.deepEqual(h.writes, ['前🙂回填😀后']); assert.equal(h.target.insert('重复'), false);
  h.target.release(); h.target.release(); assert.equal(h.releases(), 1);
});
test('editing, selection movement, focus changes and released targets refuse late results', () => {
  for (const change of [
    h => h.edit({ value: '已改', range: { location: 0, length: 0 } }),
    h => h.edit({ value: '前🙂中后', range: { location: 0, length: 0 } }),
    h => h.blur(), h => h.target.release(),
  ]) { const h = fixture(); change(h); assert.equal(h.target.insert('迟到'), false); assert.deepEqual(h.writes, []); h.target.release(); assert.equal(h.releases(), 1); }
});
test('missing or invalid selections release the target and cannot create an insertion handle', () => {
  for (const value of [null, {value:'abc',range:{location:-1,length:0}}, {value:'abc',range:{location:2,length:2}}, {value:'abc',range:{location:1.5,length:0}}]) {
    let released=0;
    assert.equal(protectInputTarget({read:()=>value,focused:()=>true,replace:()=>assert.fail('invalid write'),release:()=>released++}),null);
    assert.equal(released,1);
  }
});

test('focus moving while the input snapshot is read rejects the late insertion', () => {
  let focused = true, reads = 0, writes = 0;
  const target = protectInputTarget({
    read: () => { if (++reads > 1) focused = false; return {value:'原文',range:{location:2,length:0}}; },
    focused: () => focused, replace: () => { writes++; return true; }, release() {},
  });
  assert.equal(target.insert('迟到的文字'), false);
  assert.equal(writes, 0);
  target.release();
});
