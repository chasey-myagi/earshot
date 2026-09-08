import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { sourceLoader } from '../../../scripts/test-source-loader.mjs';

const { createDictationController } = sourceLoader(resolve('src/main/index.ts'), {})('./dictation/controller');

for (const inserted of [true, false]) {
  test(`direct input ${inserted ? 'success' : 'failure'} never publishes a preview before delivery`, async t => {
    const states = [];
    let capture;
    const controller = createDictationController({
      preflight: () => null, preview: () => false,
      target: () => ({ insert: () => inserted ? {kind:'verified'} : {kind:'not-posted',reason:'尚未填入：当前 App 拒绝写入，请复制文字'}, release() {}, failureReason: () => '尚未填入：当前 App 拒绝写入，请复制文字' }),
      capture: async port => { capture = port; return { stop: async () => {} }; },
      transcribe: async () => '保留我的文字', changed: state => states.push(state),
    });
    t.after(() => controller.cancel());
    assert.equal((await controller.begin()).ok, true);
    capture.pcm(Buffer.alloc(16000));
    await controller.end();
    assert.ok(states.some(state => state.phase === 'transcribing'));
    assert.equal(states.some(state => state.resultKind === 'preview'), false);
    const results = states.filter(state => state.phase === 'result');
    if (inserted) {
      assert.equal(results.length, 0, 'successful direct input must not expand the result UI');
      assert.equal(controller.snapshot().phase, 'success');
    } else {
      assert.equal(results.length, 1);
      assert.equal(results[0].resultKind, 'delivery-failed');
      assert.equal(results[0].text, '保留我的文字');
      assert.match(results[0].message, /尚未填入/);
      assert.equal((await controller.insert()).ok, false, 'failed target cannot be retried as a preview');
    }
  });
}
