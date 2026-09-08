import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRealtimeEventWriter } from './realtime-events.ts';

test('session diagnostics retain only latest 200 metadata events in an owner-only file', t => {
  const dir=mkdtempSync(join(tmpdir(),'earshot-realtime-events-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'realtime-events.json');writeFileSync(path,'{}',{mode:0o644});
  const record=createRealtimeEventWriter(dir);
  for(let i=0;i<205;i++)record({track:'you',at:i,event:'failed',attempt:1,taskId:'00000000-0000-4000-8000-000000000000',category:'transport',text:'must not retain',apiKey:'sk-private',headers:{secret:'private'}});
  const data=JSON.parse(readFileSync(path,'utf8'));assert.equal(data.events.length,200);assert.equal(data.events[0].at,5);
  assert.equal(statSync(path).mode & 0o777,0o600);assert.equal(JSON.stringify(data).includes('private'),false);assert.equal(JSON.stringify(data).includes('must not retain'),false);
});
test('diagnostic storage failure never interrupts the caller',()=>{
  const record=createRealtimeEventWriter('/nonexistent/earshot-fixture');
  assert.doesNotThrow(()=>record({track:'other',at:1,event:'failed',attempt:0,taskId:'fixture',category:'transport'}));
});
