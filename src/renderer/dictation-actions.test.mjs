import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
test('dictation retry remains cancelable and ignores late retry failure after a single cancel', async () => {
const require = createRequire(import.meta.url);
const code = buildSync({
  entryPoints: [fileURLToPath(new URL('./Dictation.tsx', import.meta.url))], bundle: true,
  platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react-dom'],
}).outputFiles[0].text;
let cursor = 0;
const slots = [];
const react = {
  ...require('react'),
  useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
  useState(value) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = value;
    return [slots[i], next => slots[i] = typeof next === 'function' ? next(slots[i]) : next];
  },
  useEffect() {},
};
let finish, cancels = 0;
const errors = [];
const waiting = new Promise(resolve => { finish = resolve; });
const module = { exports: {} };
runInNewContext(code, {
  module, exports: module.exports,
  require: id => id === 'react' ? react : require(id),
  window: { earshot: {
    retryDictation: () => waiting,
    cancelDictation: async () => { cancels++; },
  } },
});
const props = {
  state: { phase: 'error', text: '', message: '识别失败', retryable: true,
    startedAt: null, level: 0 },
  now: 0, actionError: '', onActionError(value) { errors.push(value); },
};
const render = () => { cursor = 0; return module.exports.DictationPanel(props); };
function all(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...[node.props?.children].flat(Infinity).flatMap(all)];
}
let tree = render();
all(tree).find(n => n.type === 'button' && n.props.children === '重试识别').props.onClick();
props.state = { ...props.state, phase: 'transcribing', message: '正在转成文字…', retryable: false };
tree = render();
const close = all(tree).find(n => n.type === 'button' && n.props['aria-label'] === '关闭语音输入');
assert.equal(close.props.disabled, false);
close.props.onClick();
close.props.onClick();
await new Promise(resolve => setImmediate(resolve));
assert.equal(cancels, 1);
finish({ ok: false, error: '迟到的重试错误' });
await new Promise(resolve => setImmediate(resolve));
assert.ok(!errors.includes('迟到的重试错误'));
});
