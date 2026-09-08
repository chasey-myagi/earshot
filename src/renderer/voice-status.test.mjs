import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { voiceRegistrationMessage } from './voice-status.ts';

// Render the actual popover with React; export it only in this in-memory build.
const source=readFileSync(new URL('./Library.tsx',import.meta.url),'utf8');
const compiled=buildSync({stdin:{contents:source+'\nexport { RenamePop };',resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'tsx'},
  bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react-dom'],loader:{'.png':'dataurl','.css':'empty'}}).outputFiles[0].text;
const mod={exports:{}};
runInNewContext(compiled,{module:mod,exports:mod.exports,require:createRequire(import.meta.url),console});
const Popover=mod.exports.RenamePop;
function markup(statuses,value='王明') {
  const records=statuses.map(status=>({name:'王明',status}));
  return renderToStaticMarkup(createElement(Popover,{from:'王明',anchor:{left:0,top:0,right:0,bottom:0,width:0,height:0},value,busy:false,count:2,people:[],
    voiceMessage:voiceRegistrationMessage(records,'王明'),retryVoice:records.some(row=>row.status==='unavailable'),onChange(){},onClose(){},onSave(){}}));
}
const messages={pending:'名字已保存，撤销期结束后记住声音。',running:'名字已保存，正在记住声音…',remembered:'已记住声音，下次录音会尝试自动识别。',
  unavailable:'名字已保存，声音暂未记住。可重试。',conflicting:'名字已保存，片段中可能有不同声音，暂不用于跨会识别。',insufficient:'名字已保存，清晰的声音片段不足。',stale:'本场分组已更新，声音尚未记住。'};
for(const [status,message] of Object.entries(messages)) test(`rename popover truthfully renders ${status}`,()=>{
  const html=markup([status]);assert.ok(html.includes(`role="status">${message}</p>`));
  assert.equal(html.includes('重试记住声音'),status==='unavailable');
});
test('mixed cluster registration states never display complete success prematurely',()=>{
  for(const status of ['pending','running','unavailable','conflicting','insufficient','stale']){
    const html=markup(['remembered',status]);assert.ok(html.includes(messages[status]));assert.ok(!html.includes(messages.remembered));
  }
  assert.ok(markup(['pending','running','unavailable']).includes(messages.running));
  assert.equal(voiceRegistrationMessage([{name:'李雷',status:'remembered'}],'王明'),undefined);
});
test('voice retry button applies only to the unchanged name',()=>{
  assert.ok(markup(['unavailable']).includes('重试记住声音'));
  const changed=markup(['unavailable'],'李雷');assert.ok(!changed.includes('重试记住声音'));assert.match(changed,/>保存<\/button>/);
});
