import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '../store/sessions.ts';
import { createPcmWavWriter } from '../store/wav.ts';
import { transcribeFile } from '../providers/file-asr.ts';
import { processSession } from './post.ts';

// The provider, journal, job and session store are real. Only HTTP and time are injected.
test('reopening after a system outage retains the microphone and resumes exactly the existing paid tasks', async t => {
  const root=mkdtempSync(join(tmpdir(),'earshot-track-recovery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=createSessionStore(root),doc=store.createRecording();store.finalize(doc.id,'complete');
  for(const track of ['mic','system']){const wav=createPcmWavWriter(join(store.sessionDir(doc.id),track+'.wav'));wav.write(Buffer.alloc(32000));wav.close();}
  let outage=true;const uploads=new Map(),submissions=[];
  const cloud=async(input,init)=>{
    const url=new URL(input);
    if(url.pathname==='/api/v1/uploads')return Response.json({data:{upload_host:'https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload',upload_dir:'fixture',policy:'fixture',signature:'fixture'}});
    if(url.pathname==='/upload'){uploads.set('oss://'+init.body.get('key'),init.body.get('file').name);return new Response('');}
    if(url.pathname.endsWith('/transcription')){const name=uploads.get(JSON.parse(init.body).input.file_urls[0]);submissions.push(name);return Response.json({output:{task_id:name}});}
    if(url.pathname.startsWith('/api/v1/tasks/')){
      const name=url.pathname.split('/').at(-1);
      if(outage&&name==='system.wav')return new Response('',{status:503});
      return Response.json({output:{task_status:'SUCCEEDED',result:{transcription_url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/'+name}}});
    }
    if(url.hostname==='dashscope-result-bj.oss-cn-beijing.aliyuncs.com')return Response.json({sentences:[{begin_time:0,end_time:1000,text:url.pathname.includes('mic')?'麦克风文字':'系统文字',speaker_id:0}]});
    throw Error('Unexpected test endpoint');
  };
  const transcribe=opts=>transcribeFile({...opts,fetchImpl:cloud,sleep:async()=>{}});
  await processSession({apiKey:'fixture-only',store,sessionId:doc.id,mode:'all',transcribe});
  const reopened=createSessionStore(root);
  assert.deepEqual(reopened.getDetail(doc.id).turns.map(row=>row.text),['麦克风文字']);
  assert.equal(reopened.readSession(doc.id).jobs.refined.status,'failed');
  outage=false;
  await processSession({apiKey:'fixture-only',store:reopened,sessionId:doc.id,mode:'all',transcribe});
  assert.deepEqual(reopened.getDetail(doc.id).turns.map(row=>row.text),['麦克风文字','系统文字']);
  assert.equal(reopened.readSession(doc.id).jobs.refined.status,'done');
  assert.deepEqual(submissions,['mic.wav','system.wav']);
  assert.equal(uploads.size,2);
  const systemJournal=JSON.parse(readFileSync(join(store.sessionDir(doc.id),'asr-system-speakers.json'),'utf8'));
  assert.equal(systemJournal.stage,'done');assert.equal(systemJournal.taskId,'system.wav');
  assert.equal(systemJournal.diagnostics.at(-1).httpStatus,503);
});
