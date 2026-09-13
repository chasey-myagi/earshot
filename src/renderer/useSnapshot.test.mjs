import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { shareSnapshotTurns } from './snapshotPick.ts';

test('library receives saved shortcuts, permission changes and deletion undo through the real snapshot hook', async () => {
  let rendered = {snap:null,error:null}, changed, unavailable = false, raw = { hasApiKey: true, sessions: [], recording: null, selected: null,
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
      window:{addEventListener(){},removeEventListener(){},earshot:{snapshot:async()=>{if(unavailable)throw Error('offline');return structuredClone(raw);},onChange:fn=>{changed=fn;return()=>{};}}}, requestAnimationFrame: fn=>fn()},
    {filename:fileURLToPath(new URL('./useSnapshot.ts',import.meta.url))});
  const hook = module.exports.useSnapshot(); effects.forEach(fn=>fn());
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(rendered.snap.shortcuts?.prefs.dictation,'Command+Shift+D');
  assert.equal(rendered.snap.shortcuts?.prefs.delivery,'preview');
  assert.equal(rendered.snap.dictation?.text,'保留的输入');
  raw = {...raw, shortcuts:{...raw.shortcuts,accessibility:true}, deletions:[{sessionId:'deleted',title:'测试会话'}]};
  changed(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(rendered.snap.shortcuts.accessibility,true);
  assert.equal(rendered.snap.deletions[0].sessionId,'deleted');
  // A failed refresh keeps the usable document and exposes a retryable error.
  unavailable = true; await hook.refresh();
  assert.equal(rendered.snap.deletions[0].sessionId,'deleted');
  assert.match(rendered.error, /重试/);
  unavailable = false; await hook.refresh();
  assert.equal(rendered.error, null);
});
