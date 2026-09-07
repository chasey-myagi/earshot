import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startDictationStream } from './dictation-stream.ts';
function socket(){let open,message,error,close;const sent=[];return {sent,connect:()=>({send:data=>sent.push(Buffer.isBuffer(data)?Buffer.from(data):JSON.parse(data)),close(){},onOpen:fn=>open=fn,onMessage:fn=>message=fn,onError:fn=>error=fn,onClose:fn=>close=fn}),open:()=>open(),message:value=>message(JSON.stringify(value)),error:()=>error(new Error('secret')),close:()=>close()};}
test('audio captured during connection is preserved, finish waits for confirmed sentences and task completion', async t=>{
 const os=socket(),abort=new AbortController();t.after(()=>abort.abort());const stream=startDictationStream({apiKey:'fixture',model:'qwen-audio-3.0-asr-flash-streaming',signal:abort.signal,connect:os.connect});
 const pcm=Buffer.alloc(6400,7);stream.send(pcm);pcm.fill(9);const finished=stream.finish();let resolved=false;finished.then(()=>resolved=true);os.open();
 assert.equal(os.sent.length,1);assert.equal(os.sent[0].payload.model,'qwen-audio-3.0-asr-flash-streaming');
 os.message({header:{event:'task-started'}});assert.deepEqual(os.sent[1],Buffer.alloc(6400,7));assert.equal(os.sent[2].header.action,'finish-task');
 os.message({header:{event:'result-generated'},payload:{output:{sentence:{sentence_id:0,text:'错误草稿',sentence_end:false,begin_time:0}}}});
 os.message({header:{event:'result-generated'},payload:{output:{sentence:{sentence_id:0,text:'最终文本',sentence_end:true,begin_time:0}}}});
 await Promise.resolve();assert.equal(resolved,false);os.message({header:{event:'task-finished'}});assert.equal(await finished,'最终文本');
});
test('Qwen3 manual protocol commits at release and returns only completed transcript', async t=>{
 const os=socket(),abort=new AbortController();t.after(()=>abort.abort());const stream=startDictationStream({apiKey:'fixture',model:'qwen3-asr-flash-realtime',signal:abort.signal,connect:os.connect});
 os.open();assert.equal(os.sent[0].session.turn_detection,null);os.message({type:'session.updated'});stream.send(Buffer.alloc(6400,4));
 assert.equal(os.sent[1].type,'input_audio_buffer.append');assert.equal(Buffer.from(os.sent[1].audio,'base64').length,6400);
 const finished=stream.finish();assert.deepEqual(os.sent.slice(2).map(s=>s.type),['input_audio_buffer.commit','session.finish']);
 os.message({type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'数字7039'});os.message({type:'session.finished'});assert.equal(await finished,'数字7039');
});
test('cancel closes pending recognition and never resolves from a late response', async()=>{
 const os=socket(),abort=new AbortController();const stream=startDictationStream({apiKey:'fixture',model:'qwen-audio-3.0-asr-flash-streaming',signal:abort.signal,connect:os.connect});
 const finished=stream.finish();abort.abort();await assert.rejects(finished,/已取消/);os.open();os.message({header:{event:'task-finished'}});assert.deepEqual(os.sent,[]);
});
