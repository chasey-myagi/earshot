import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {buildSync} from 'esbuild';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const code=buildSync({entryPoints:[fileURLToPath(new URL('./Dictation.tsx',import.meta.url))],bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react-dom']}).outputFiles[0].text;
const mod={exports:{}};runInNewContext(code,{module:mod,exports:mod.exports,require:createRequire(import.meta.url),console});
const render=(name,props)=>renderToStaticMarkup(createElement(mod.exports[name],props));
const state={phase:'result',resultKind:'delivery-unconfirmed',text:'明天上午开会',message:'请检查输入框',startedAt:null,level:0,retryable:false};
test('unconfirmed HUD retains text and copy without a success glyph or repeated input action',()=>{
 const html=render('DictationPanel',{state,now:0,actionError:'',onActionError(){}});
 for(const text of [state.text,state.message,'已发送一次粘贴，无法确认是否填入','复制文字'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/✓|插入原位置|重试识别/);
});
test('preview offers copy only and in-progress delivery does not flash recognized text',()=>{
 const props={now:0,actionError:'',onActionError(){}};
 const preview=render('DictationPanel',{...props,state:{...state,resultKind:'preview'}});assert.match(preview,/复制文字/);assert.doesNotMatch(preview,/插入原位置/);
 const pending=render('DictationPanel',{...props,state:{...state,phase:'transcribing',resultKind:undefined,message:'正在填入'}});assert.doesNotMatch(pending,/明天上午开会|复制文字/);
});
test('one auto-fill setting replaces the application-specific toggle and preserves preview preference',()=>{
 const html=render('DictationSettings',{});assert.match(html,/aria-label="自动填入" aria-checked="true"/);assert.doesNotMatch(html,/微信兼容输入/);assert.match(html,/临时剪贴板/);
 const preview=render('DictationSettings',{status:{prefs:{enabled:true,meeting:'Alt+M',dictation:'Alt+Space',delivery:'preview',wechatCompatibility:true},holdAvailable:true,accessibility:true}});
 assert.match(preview,/aria-label="自动填入" aria-checked="false"/);assert.doesNotMatch(preview,/微信兼容输入/);
});
