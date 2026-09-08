import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { floatToS16le, resampleFloat } from '../shared/pcm.ts';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const compiled=ts.transpileModule(readFileSync(new URL('./dictation-capture.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture({denied=false}={}){
 let start, hide, node, opens=0, stops=0, closes=0, failures=0; const frames=[];
 const track={stop(){stops++;}};
 class Context { sampleRate=16000; destination={}; audioWorklet={addModule:async()=>{}}; async resume(){} async close(){closes++;} createMediaStreamSource(){return{connect(){}};} createGain(){return{gain:{},connect(){}};} }
 class Worklet {constructor(){node=this;this.port={};}connect(){}}
 const window={dictationCapture:{onStart:fn=>start=fn,failed:()=>failures++,pcm:bytes=>frames.push(bytes)},addEventListener:(name,fn)=>{if(name==='pagehide')hide=fn;}};
 runInNewContext(compiled,{exports:{},require:()=>({floatToS16le,resampleFloat}),window,
 navigator:{mediaDevices:{getUserMedia:async()=>{opens++;if(denied)throw Error('denied');return{getTracks:()=>[track],getAudioTracks:()=>[track]};}}},
 AudioContext:Context,AudioWorkletNode:Worklet,Blob,URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}},Float32Array});
 return {start:()=>start(),hide:()=>hide?.(),node:()=>node,frames,opens:()=>opens,stops:()=>stops,closes:()=>closes,failures:()=>failures};
}
test('loading the actual capture renderer stays microphone-free; explicit start captures PCM and pagehide releases tracks',async()=>{
 const h=fixture();await tick();assert.equal(h.opens(),0);assert.equal(h.node(),undefined);
 h.start();await tick();assert.equal(h.opens(),1);h.node().port.onmessage({data:new Float32Array([0,.5,-.5])});assert.deepEqual(h.frames,[floatToS16le(new Float32Array([0,.5,-.5]))]);
 h.hide();await tick();assert.equal(h.stops(),1);assert.equal(h.closes(),1);assert.equal(h.failures(),0);
});
test('permission denial happens only after explicit start and reports failure without a PCM frame',async()=>{
 const h=fixture({denied:true});await tick();assert.equal(h.opens(),0);h.start();await tick();assert.equal(h.opens(),1);assert.equal(h.failures(),1);assert.deepEqual(h.frames,[]);
});
