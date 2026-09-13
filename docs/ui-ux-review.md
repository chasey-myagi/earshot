## 🔍 Code Review Report

**Target**: `/Users/chasey/Dev/personal-projects/earshot-ui-polish`，分支 `codex/ui-ux-comprehensive`；HEAD/基线 `553b8fb96fbdd5fc12ee5b106e919a7c7389fcbe`，审查当前 tracked diff 与明确指定的新源码、测试、动效和说明文档。
**Feature**: 实际 Electron/React App 全面 UI/UX 整理，重点为搜索占位与重复标题、播放布局、删除失败反馈、取消/重试、错误恢复和动效生命周期。
**Changed Files**: 32 files +766/-242
**Language**: TypeScript / React 19 / Electron / CSS / Node test runner

审查内容指纹（按文件路径排序，串接路径、NUL、文件字节、NUL 后 SHA-256）：`cfcb6f376055cc4d29712564d6e7981cf09f6b8b9beaf622e371e48473a66b50`。本报告对应 2026-09-14 最终修正后的内容；之后新增回归测试不自动包含在这一指纹中。`node_modules`、`models` 是本地符号链接，排除；`qa-preview.html` 是开发检查辅助页，已查看但不计入指定实现范围。

独立需求依据：`PRODUCT.md`、`DESIGN.md`、`AGENTS.md`、`docs/ui-ux-polish.md` 及派发输入中的用户历史痛点。未从 diff 反推需求。

### Scores

| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Correctness | 8.4 | 25% | 2.10 |
| Security | 8.0 | 15% | 1.20 |
| Architecture | 8.0 | 20% | 1.60 |
| Error Handling | 8.4 | 15% | 1.26 |
| Maintainability | 8.0 | 15% | 1.20 |
| Requirements Fit | 8.4 | 10% | 0.84 |
| **Final Score** | | | **8.20** |

安全性适用范围为搜索、标题和转写等来源文本的渲染、动态正则的构造，以及 DEV mock 与生产 preload 的边界；本轮未新增密钥存储、外网调用、原生依赖或授权机制。

### Result: PASS ✅

各适用维度 ≥ 7.0，最终分数 8.20；最终版本没有剩余 Critical、Important 或 Minor finding。审查中发现的取消按钮失效、标题命中重复、退场误显失败和高亮布局/分词问题均已修复，并核对了最终源码。

### Strengths

- [session-removal.ts](/Users/chasey/Dev/personal-projects/earshot-ui-polish/src/renderer/session-removal.ts:4) 将标题和列表删除入口汇合至同一个会话请求；finally 统一释放 pending，失败后可重试，没有增加主进程或运行时层次。
- [SessionList.tsx](/Users/chasey/Dev/personal-projects/earshot-ui-polish/src/renderer/SessionList.tsx:126) 将多选操作与单次失败分开，失败保留目标并给出重试/关闭动作；不再把一条删除失败显示成批量选择状态。
- [useSnapshot.ts](/Users/chasey/Dev/personal-projects/earshot-ui-polish/src/renderer/useSnapshot.ts:27) 刷新失败保留已有可用数据，提供错误反馈；请求代号阻止旧响应覆盖新快照。
- [Dictation.tsx](/Users/chasey/Dev/personal-projects/earshot-ui-polish/src/renderer/Dictation.tsx:34) 普通操作与取消分别防重，取消使旧请求反馈失效，重试中的关闭仍可触达。
- [SearchPanel.tsx](/Users/chasey/Dev/personal-projects/earshot-ui-polish/src/renderer/SearchPanel.tsx:13) 高亮使用转义后的字面量正则和 React 文本节点；按词处理标题、说话人与片段，保留输入中的正则字符和 HTML 转义。
- [usePresence.ts](/Users/chasey/Dev/personal-projects/earshot-ui-polish/src/renderer/usePresence.ts:4)、[SessionRow.tsx](/Users/chasey/Dev/personal-projects/earshot-ui-polish/src/renderer/SessionRow.tsx:101) 支持退场延迟卸载、快速重新打开与无交互退场；删除通知保持最后有效文案，不在成功路径闪现失败。
- [styles.css](/Users/chasey/Dev/personal-projects/earshot-ui-polish/src/renderer/styles.css:178) 用自然纵向布局承载反馈栏和播放器，避免依赖通知数量拼接固定 grid 行；动效与加载状态遵守减少动态效果偏好。

### Issues

#### Critical（必须修复）

无未解决问题。

#### Important（应该修复）

无未解决问题。

#### Minor（建议改进）

无未解决问题。

### Recommendations

将附录中的取消/迟到响应场景保留为行为回归测试。源代码评审通过后，实际窗口的最小尺寸、深浅色、键盘和浮窗验收仍应单独记录；本评审没有使用 UI 自动化，也没有执行真实录音、系统权限或云端识别。

### Assessment

**Ready to merge?** Yes（仅就记录的代码范围）

**Reasoning:** 搜索、删除与取消状态路径的已确认问题已关闭，相关测试和类型检查通过；实现继续沿用单 Electron 主进程、渲染层经 preload 调用的既有边界。本报告不替代 CI、真实产品验收或发布授权。

### Validation Evidence

- 全量 `npm run typecheck && npm test`：737 passed / 1 skipped / 0 failed，总计 738 tests。该次发生在最终少量 UI 修正之前。
- 最终取消/搜索/通知修正后：`npm run typecheck` 通过；`node --test src/renderer/*.test.mjs src/main/dictation/controller.test.mjs`：89 passed / 0 failed。
- 最后一次高亮分词修正：在内存编译实际 `Highlight` 并以 React SSR 验证，说话人与正文各词均有高亮；`[.*` 作为字面量可高亮；输入中的 `<img ...>` 仍被转义。
- 实际 `DictationPanel` 的只读组件状态执行：识别重试仍 pending 时关闭按钮 enabled；同帧两次关闭只调用一次取消；取消后迟到的重试失败不写回提示。
- 实际 `SearchPanel` 的只读结构执行：标题独占命中仅一个可点击组标题，零重复 snippet；最终 CSS 已显式 `display: block`，不会把高亮片段拆成 grid 行。
- 实际 `DeletionNotices` 的只读状态执行：普通删除通知退场仍显示上一条有效删除文案，不包含“恢复未完成”。
- 未验证：原生权限、真实系统音频、录音浮窗布局、跨应用输入、实际云调用。没有将 headless 检查当作这些项目的验收。

### Appendix: 取消回归脚本

以下脚本只在内存编译/执行实际组件，不写源码、不连接云端。它采用受控 hooks 重渲染以检查事件与状态行为，不覆盖浏览器焦点、布局或原生窗口。执行目录为审查工作区。

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const code = buildSync({
  entryPoints: ['src/renderer/Dictation.tsx'], bundle: true,
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
console.log('PASS: pending retry leaves close enabled; double close sends once; late retry failure is ignored.');
NODE
```

执行结果：`PASS: pending retry leaves close enabled; double close sends once; late retry failure is ignored.`
