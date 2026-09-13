import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSessionRows } from './session-selection.ts';
const visible = ['recording-a', 'input-a', 'input-b', 'recording-b', 'input-c'];
const empty = { ids: [], anchor: null };

test('ordinary selection replaces, command toggles, and command can clear the final row', () => {
  let s = selectSessionRows(empty, visible, visible[0]);
  s = selectSessionRows(s, visible, visible[2], { metaKey: true });
  assert.deepEqual(s.ids, [visible[0], visible[2]]);
  s = selectSessionRows(s, visible, visible[0], { metaKey: true });
  assert.deepEqual(s.ids, [visible[2]]);
  s = selectSessionRows(s, visible, visible[2], { metaKey: true });
  assert.deepEqual(s.ids, []);
  assert.deepEqual(selectSessionRows({ ids: visible, anchor: visible[0] }, visible, visible[1]).ids, [visible[1]]);
});

test('shift range keeps anchor and can extend or shrink in either direction', () => {
  const s = selectSessionRows(empty, visible, visible[2]);
  const back = selectSessionRows(s, visible, visible[0], { shiftKey: true });
  assert.deepEqual(back, { ids: visible.slice(0, 3), anchor: visible[2] });
  assert.deepEqual(selectSessionRows(back, visible, visible[4], { shiftKey: true }).ids, visible.slice(2));
  assert.deepEqual(selectSessionRows(back, visible, visible[1], { shiftKey: true }).ids, visible.slice(1, 3));
});

test('command shift adds a range while filtering out hidden rows and expired anchors', () => {
  const s = { ids: [visible[0], visible[4]], anchor: visible[4] };
  assert.deepEqual(selectSessionRows(s, visible, visible[3], { metaKey: true, shiftKey: true }).ids, [visible[0], visible[3], visible[4]]);
  const filtered = [visible[1], visible[2], visible[4]];
  assert.deepEqual(selectSessionRows({ ids: [visible[0]], anchor: visible[0] }, filtered, visible[2], { shiftKey: true }), { ids: [visible[2]], anchor: visible[2] });
  assert.equal(selectSessionRows(s, filtered, 'missing'), s);
});
