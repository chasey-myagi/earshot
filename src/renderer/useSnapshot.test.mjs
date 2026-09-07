import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { shareSnapshotTurns } from './snapshotPick.ts';

test('library receives saved shortcuts, permission changes and deletion undo through the real snapshot hook', async () => {
  let rendered, changed, raw = { hasApiKey: true, sessions: [], recording: null, selected: null,
    shortcuts: { prefs: {enabled:true,meeting:'Control+Alt+R',dictation:'Command+Shift+D',delivery:'preview'}, accessibility:false,holdAvailable:true },
    dictation: {phase:'result',text:'保留的输入'}, deletions: [],
  };
  const effects = [], module = {exports:{}};
  const source = readFileSync(new URL('./useSnapshot.ts', import.meta.url), 'utf8');
  const react = { useCallback: fn => fn, useRef: current => ({current}), useEffect: fn => effects.push(fn),
    useState: initial => [initial, update => rendered = typeof update === 'function' ? update(rendered) : update],
  };
  runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {module,exports:module.exports,require: id => id === 'react' ? react : {shareSnapshotTurns},
      window:{addEventListener(){},removeEventListener(){},earshot:{snapshot:async()=>structuredClone(raw),onChange:fn=>{changed=fn;return()=>{};}}}, requestAnimationFrame: fn=>fn()},
    {filename:fileURLToPath(new URL('./useSnapshot.ts',import.meta.url))});
  module.exports.useSnapshot(); effects.forEach(fn=>fn());
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(rendered.shortcuts?.prefs.dictation,'Command+Shift+D');
  assert.equal(rendered.shortcuts?.prefs.delivery,'preview');
  assert.equal(rendered.dictation?.text,'保留的输入');
  raw = {...raw, shortcuts:{...raw.shortcuts,accessibility:true}, deletions:[{sessionId:'deleted',title:'测试会话'}]};
  changed(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(rendered.shortcuts.accessibility,true);
  assert.equal(rendered.deletions[0].sessionId,'deleted');
});
