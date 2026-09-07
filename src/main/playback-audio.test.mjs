import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, openSync, closeSync, ftruncateSync, writeSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPcmWavWriter } from "./store/wav.ts";
import { audioResponse, openSessionAudio } from "./playback-audio.ts";

function fixture(t, tracks) {
  const dir = mkdtempSync(join(tmpdir(), "earshot-mix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, samples] of Object.entries(tracks)) {
    const writer = createPcmWavWriter(join(dir, name));
    const pcm = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, i) => pcm.writeInt16LE(sample, i * 2));
    writer.write(pcm); writer.close();
  }
  return dir;
}

test("dual-track playback exposes one seekable WAV with silence padding on the shorter track", t => {
  const dir = fixture(t, { "mic.wav": [1000, -2000, 3000], "system.wav": [3000, 2000, -1000, 8000] });
  const mix = openSessionAudio(dir);
  assert.equal(mix.byteLength, 52);
  assert.equal(mix.durationSec, 4 / 16000);
  const reader = mix.openReader(); t.after(() => reader.close());
  const whole = reader.read(0, 52);
  assert.equal(whole.toString("ascii", 0, 4), "RIFF");
  assert.equal(whole.readUInt32LE(40), 8);
  assert.deepEqual([...new Int16Array(whole.buffer, whole.byteOffset + 44, 4)], [2000, 0, 1000, 4000]);
  assert.deepEqual(reader.read(45, 5), whole.subarray(45, 50));
  assert.deepEqual(reader.read(42, 6), whole.subarray(42, 48));
});

test("media Range requests return exact bytes and invalid ranges cannot reach outside the audio", async t => {
  const dir = fixture(t, { "mic.wav": [1000, 2000, 3000, 4000] });
  const mix = openSessionAudio(dir);
  const full = Buffer.from(await audioResponse(new Request("https://local/audio"), mix).arrayBuffer());
  for (const [range, first, last] of [["bytes=43-48", 43, 48], ["bytes=48-", 48, 51], ["bytes=-3", 49, 51]]) {
    const response = audioResponse(new Request("https://local/audio", { headers: { Range: range } }), mix);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), `bytes ${first}-${last}/52`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), full.subarray(first, last + 1));
  }
  for (const range of ["bytes=52-", "bytes=8-4", "bytes=-0", "bytes=0-1,4-5", "bytes=999999999999999999999-", "invalid"]) {
    const response = audioResponse(new Request("https://local/audio", { headers: { Range: range } }), mix);
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get("content-range"), "bytes */52");
  }
  const head = audioResponse(new Request("https://local/audio", { method: "HEAD" }), mix);
  assert.equal(head.headers.get("content-length"), "52");
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test("missing, corrupt, unsupported and linked tracks cannot replace a valid local track", t => {
  const dir = fixture(t, { "mic.wav": [2000, -3000] });
  const check = () => {
    const mix = openSessionAudio(dir), reader = mix.openReader();
    assert.equal(mix.warning, '当前只有一路可用音轨');
    assert.deepEqual(reader.read(44, 4), readFileSync(join(dir, 'mic.wav')).subarray(44));
    reader.close();
  };
  check();
  writeFileSync(join(dir, 'system.wav'), 'not wav'); check();
  const invalid = readFileSync(join(dir, 'mic.wav')); invalid.writeUInt16LE(3, 20);
  writeFileSync(join(dir, 'system.wav'), invalid); check();
  invalid.writeUInt16LE(1, 20); invalid.writeUInt32LE(48000, 24);
  writeFileSync(join(dir, 'system.wav'), invalid); check();
  rmSync(join(dir, 'system.wav')); symlinkSync(join(dir, 'mic.wav'), join(dir, 'system.wav')); check();
  rmSync(join(dir, 'mic.wav'));
  assert.throws(() => openSessionAudio(dir), /没有可播放的音轨/);
});

test("a 90-minute WAV reads its tail without loading the whole recording", async t => {
  const dir = fixture(t, { 'mic.wav': [0] });
  const path = join(dir, 'mic.wav'), bytes = 5400 * 32000;
  const header = readFileSync(path).subarray(0, 44);
  header.writeUInt32LE(bytes + 36, 4); header.writeUInt32LE(bytes, 40);
  const fd = openSync(path, 'w');
  writeSync(fd, header); ftruncateSync(fd, bytes + 44);
  const tail = Buffer.from([0x34, 0x12]); writeSync(fd, tail, 0, 2, bytes + 42); closeSync(fd);
  const mix = openSessionAudio(dir); assert.equal(mix.durationSec, 5400);
  const r = audioResponse(new Request('https://local/audio', { headers: { range: 'bytes=-2' } }), mix);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), tail);
  const reader = mix.openReader();
  assert.throws(() => reader.read(0, 65537), /无效/);
  reader.close(); assert.throws(() => reader.read(0, 2), /已结束/);
});

test("request abort, playback revocation and stream cancellation close the reader immediately", async () => {
  for (const way of ['request', 'revoke', 'cancel']) {
    let closed = 0, read = 0;
    const request = new AbortController(), revoked = new AbortController();
    const audio = { byteLength: 1_000_000, openReader: () => ({
      read: (_offset, length) => { read++; assert.ok(length <= 65536); return Buffer.alloc(length); },
      close: () => { closed++; },
    }) };
    const response = audioResponse(new Request('https://local/audio', { signal: request.signal }), audio, () => true, revoked.signal);
    const reader = response.body.getReader();
    assert.equal((await reader.read()).value.byteLength, 65536);
    if (way === 'request') request.abort();
    else if (way === 'revoke') revoked.abort();
    else await reader.cancel();
    assert.equal(closed, 1, way); assert.ok(read <= 2);
    if (way !== 'cancel') await assert.rejects(reader.read(), /音频请求已结束/);
  }
});

test("a truncated track fails its stream and closes the reader instead of serving corrupt audio", async t => {
  const dir = fixture(t, { 'mic.wav': [1, 2, 3, 4] });
  const mix = openSessionAudio(dir);
  writeFileSync(join(dir, 'mic.wav'), readFileSync(join(dir, 'mic.wav')).subarray(0, 45));
  await assert.rejects(audioResponse(new Request('https://local/audio'), mix).arrayBuffer(), /音频读取失败/);
});

test('multi-chunk dual PCM mixing preserves extreme samples, odd range edges and a silent track', async t => {
  const patterns=[-32768,32767,-1,0,1,16000,-16000];
  const mic=Array.from({length:80_003},(_,i)=>patterns[i%patterns.length]);
  const system=mic.map((_,i)=>i<35_001?0:patterns[(i+3)%patterns.length]);
  const dir=fixture(t,{'mic.wav':mic,'system.wav':system});
  const expected=Buffer.alloc(mic.length*2);
  for(let i=0;i<mic.length;i++) expected.writeInt16LE(Math.round((mic[i]+system[i])/2),i*2);
  const audio=openSessionAudio(dir);
  const whole=Buffer.from(await audioResponse(new Request('https://local/audio'),audio).arrayBuffer());
  assert.deepEqual(whole.subarray(44),expected);
  const response=audioResponse(new Request('https://local/audio',{headers:{Range:'bytes=65535-140000'}}),audio);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),whole.subarray(65535,140001));
  const systemOnly=fixture(t,{'system.wav':[32767,-32768]});
  const reader=openSessionAudio(systemOnly).openReader();try {assert.deepEqual(reader.read(44,4),Buffer.from([255,127,0,128]));}finally{reader.close();}
  const empty=fixture(t,{'mic.wav':[]});assert.throws(()=>openSessionAudio(empty),/没有可播放/);
  const malformed=readFileSync(join(systemOnly,'system.wav'));malformed.writeUInt32LE(2,16);
  writeFileSync(join(empty,'system.wav'),malformed);assert.throws(()=>openSessionAudio(empty),/没有可播放/);
});

test('HEAD opens no PCM reader and a failing read closes its descriptors exactly once', async t => {
  const audio=openSessionAudio(fixture(t,{'mic.wav':[1,2,3]}));
  let opened=0,closed=0;
  const instrumented={...audio,openReader:()=>{opened++;const reader=audio.openReader();return{read:()=>{throw Error('read failed');},close:()=>{closed++;reader.close();}};}};
  assert.equal(audioResponse(new Request('https://local/audio',{method:'HEAD'}),instrumented).status,200);
  assert.equal(opened,0);
  await assert.rejects(audioResponse(new Request('https://local/audio'),instrumented).arrayBuffer(),/音频读取失败/);
  assert.equal(opened,1);assert.equal(closed,1);
});

test('file-system boundary observes bounded long-file IO and closes an earlier track if opening the next fails', async t => {
  const fs=(await import('node:fs')).default;
  const {syncBuiltinESMExports}=await import('node:module');
  const dir=fixture(t,{'mic.wav':[100], 'system.wav':[200]});
  const path=join(dir,'mic.wav'),bytes=5400*32000;
  const header=readFileSync(path).subarray(0,44);header.writeUInt32LE(bytes+36,4);header.writeUInt32LE(bytes,40);
  const file=openSync(path,'w');writeSync(file,header);ftruncateSync(file,bytes+44);closeSync(file);
  const original={readSync:fs.readSync,openSync:fs.openSync,closeSync:fs.closeSync};
  const reads=[],opened=[],closed=[];let failSystem=false;
  try {
    fs.readSync=(fd,buffer,offset,length,position)=>{reads.push({length,position});return original.readSync(fd,buffer,offset,length,position);};
    fs.openSync=(path,...rest)=>{if(failSystem && String(path).endsWith('system.wav'))throw Error('second open failed');const fd=original.openSync(path,...rest);opened.push(fd);return fd;};
    fs.closeSync=fd=>{closed.push(fd);return original.closeSync(fd);};
    syncBuiltinESMExports();
    const audio=openSessionAudio(dir);
    const response=audioResponse(new Request('https://local/audio',{headers:{Range:'bytes=-2'}}),audio);
    assert.equal((await response.arrayBuffer()).byteLength,2);
    assert.ok(reads.reduce((sum,row)=>sum+row.length,0)<4096,JSON.stringify(reads));
    assert.ok(reads.some(row=>row.position===bytes+42 && row.length===2));
    assert.equal(opened.length,closed.length);
    const beforeOpen=opened.length,beforeClose=closed.length;failSystem=true;
    assert.throws(()=>audio.openReader(),/second open failed/);
    assert.equal(opened.length-beforeOpen,1);assert.equal(closed.length-beforeClose,1);
  } finally {Object.assign(fs,original);syncBuiltinESMExports();}
});
