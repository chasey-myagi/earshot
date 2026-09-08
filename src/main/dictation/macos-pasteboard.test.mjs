import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { sourceLoader } from '../../../scripts/test-source-loader.mjs';

// Deliberately use a separate named pasteboard. Never inspect the user's general clipboard.
test('AppKit round trip retains all advertised formats, custom bytes and multiple file items', {skip:process.platform!=='darwin'}, () => {
  const {createMacPasteboard,PASTE_MARKER}=sourceLoader(resolve('src/main/dictation/macos-pasteboard.ts'),{})('./macos-pasteboard');
  const board=createMacPasteboard(`app.earshot.synthetic-pasteboard.${process.pid}`);
  try {
    const original=[[
      {type:'public.utf8-plain-text',data:Buffer.from('Synthetic 🙂\n第二行')},
      {type:'public.html',data:Buffer.from('<b>Synthetic</b>')},
      {type:'public.rtf',data:Buffer.from('{\\rtf1\\ansi Synthetic}')},
      {type:'app.earshot.custom-fixture',data:Buffer.from([0,1,2,253,254,255])},
      {type:'public.png',data:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64')},
    ],...['one','two'].map(name=>[{type:'public.file-url',data:Buffer.from(`file:///tmp/earshot-synthetic-${name}.txt`)}])];
    assert.notEqual(board.replace(original,board.changeCount()),null);
    const before=board.snapshot();
    // AppKit may advertise derived representations. Preserve those too, rather
    // than pretending the supplied list is the full system pasteboard.
    for(const [i,item] of original.entries()) for(const entry of item) {
      assert.deepEqual(Buffer.from(before.items[i].find(x=>x.type===entry.type).data),entry.data);
    }
    const temporary=[[{type:'public.utf8-plain-text',data:Buffer.from('临时结果')},{type:PASTE_MARKER,data:Buffer.from('fixture-session')}]];
    const version=board.replace(temporary,before.changeCount);assert.equal(board.owns(version,'fixture-session'),true);
    assert.notEqual(board.replace(before.items,version),null);
    assert.equal(JSON.stringify(board.snapshot().items),JSON.stringify(before.items));
    assert.equal(board.owns(version,'fixture-session'),false);
  } finally {board.close();}
});

test('AppKit refuses advertised file promises before replacing any original data', {skip:process.platform!=='darwin'}, () => {
  const {createMacPasteboard}=sourceLoader(resolve('src/main/dictation/macos-pasteboard.ts'),{})('./macos-pasteboard');
  const board=createMacPasteboard(`app.earshot.synthetic-promise.${process.pid}`);
  try {
    board.replace([[{type:'com.apple.pasteboard.promised-file-url',data:Buffer.from('synthetic')}]],board.changeCount());
    const before=board.changeCount();assert.throws(()=>board.snapshot(),/延迟文件/);assert.equal(board.changeCount(),before);
  } finally {board.close();}
});

test('Electron worker copies native pasteboard bytes without external ArrayBuffers', {skip:process.platform!=='darwin'}, async () => {
  const {createRequire}=await import('node:module');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
  const electron=createRequire(import.meta.url)('electron');
  const workerCode=`
    import {parentPort} from 'node:worker_threads';
    import {sourceLoader} from ${JSON.stringify(new URL('../../../scripts/test-source-loader.mjs',import.meta.url).href)};
    const load=sourceLoader(${JSON.stringify(resolve('src/main/dictation/macos-pasteboard.ts'))},{});
    const board=load('./macos-pasteboard').createMacPasteboard('app.earshot.electron-worker.'+process.pid);
    const lease=load('./clipboard').createClipboardLease(board);
    try {
      const bytes=Buffer.from([0,1,2,255]);board.replace([[{type:'app.earshot.test-bytes',data:bytes}]],board.changeCount());
      const id=lease.claim('Synthetic 🙂',()=>false);if(!lease.owned(id))throw Error('Lease not owned');
      if(lease.finish(id)!=='restored')throw Error('Not restored');
      if(!Buffer.from(board.snapshot().items[0][0].data).equals(bytes))throw Error('Bytes changed');
      parentPort.postMessage('pass');
    }finally{board.close();}
  `;
  const script=`import {Worker} from 'node:worker_threads';
    const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(${JSON.stringify(workerCode)})),{execArgv:[]});
    const result=await new Promise((resolve,reject)=>{worker.on('message',resolve);worker.on('error',reject);worker.on('exit',code=>{if(code)reject(Error('Worker exit '+code));});});
    if(result!=='pass')throw Error('Native worker test failed');console.log('pass');`;
  const result=await promisify(execFile)(electron,['--input-type=module','-e',script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},timeout:10000,maxBuffer:1024*128});
  assert.equal(result.stdout.trim(),'pass');
});
