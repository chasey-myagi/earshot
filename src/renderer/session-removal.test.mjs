import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionRemover } from './session-removal.ts';

test('title and list deletion share one request and preserve its result', async () => {
  let release, calls = 0;
  const operation = new Promise(resolve => { release = resolve; });
  const removal = createSessionRemover(() => { calls++; return operation; });
  const title = removal.remove('same-session'), list = removal.remove('same-session');
  await Promise.resolve();
  assert.equal(calls, 1); assert.equal(removal.isPending('same-session'), true);
  release({ ok: true });
  assert.deepEqual(await Promise.all([title, list]), [{ ok: true }, { ok: true }]);
  assert.equal(removal.isPending('same-session'), false);
});

test('a failed deletion releases every entry point for retry', async () => {
  let calls = 0;
  const removal = createSessionRemover(async () => { if (++calls === 1) throw Error('IPC disconnected'); return { ok: true }; });
  const first = removal.remove('session'), second = removal.remove('session');
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(removal.isPending('session'), false);
  assert.deepEqual(await removal.remove('session'), { ok: true }); assert.equal(calls, 2);
});
