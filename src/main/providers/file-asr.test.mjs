import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { parseTranscriptionFile, toSessionTurns, transcribeFile } from "./file-asr.ts";

let root;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("parseTranscriptionFile keeps sentence end_time", () => {
  const rows = parseTranscriptionFile({
    transcripts: [
      {
        sentences: [{ begin_time: 15, end_time: 40, text: "你好", speaker_id: 0 }],
      },
    ],
  });
  assert.deepEqual(rows, [{ tStartMs: 15, tEndMs: 40, text: "你好", speakerId: 0 }]);
});

test("parseTranscriptionFile reads transcripts.sentences", () => {
  const rows = parseTranscriptionFile({
    transcripts: [
      {
        sentences: [
          { begin_time: 15, text: "你好", speaker_id: 0 },
          { begin_time: 40, text: "  ", speaker_id: 1 },
        ],
      },
    ],
  });
  assert.deepEqual(rows, [{ tStartMs: 15, text: "你好", speakerId: 0 }]);
});

test("toSessionTurns keeps 你 on mic and maps system speakers", () => {
  const you = toSessionTurns([{ tStartMs: 0, tEndMs: 12, text: "我", speakerId: 3 }], "you", true);
  assert.equal(you[0].speaker, "你");
  assert.equal(you[0].tEndMs, 12);
  const other = toSessionTurns([{ tStartMs: 0, text: "他", speakerId: 0 }], "other", true);
  assert.equal(other[0].speaker, "小 A");
  const plain = toSessionTurns([{ tStartMs: 0, text: "他", speakerId: 0 }], "other", false);
  assert.equal(plain[0].speaker, "对方");
});

test("transcribeFile uploads, submits, polls, and downloads", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  const calls = [];
  const result = await transcribeFile({
    apiKey: "sk-test",
    filePath,
    diarize: true,
    sleep: async () => undefined,
    fetchImpl: async (input, init) => {
      const headers = init?.headers;
      const auth = headers && typeof headers === "object" && "Authorization" in headers ? headers.Authorization : undefined;
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        auth,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (String(input).includes("action=getPolicy")) {
        return new Response(
          JSON.stringify({
            data: {
              upload_host: "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload",
              upload_dir: "dashscope/tmp",
              policy: "p",
              signature: "s",
              oss_access_key_id: "id",
            },
          }),
          { status: 200 },
        );
      }
      if (String(input) === "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload") {
        return new Response("", { status: 200 });
      }
      if (String(input).includes("/transcription")) {
        return new Response(JSON.stringify({ output: { task_id: "task-1" } }), { status: 200 });
      }
      if (String(input).includes("/tasks/task-1")) {
        return new Response(
          JSON.stringify({
            output: {
              task_status: "SUCCEEDED",
              results: [{ transcription_url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json" }],
            },
          }),
          { status: 200 },
        );
      }
      if (String(input) === "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json") {
        return new Response(
          JSON.stringify({
            transcripts: [{ sentences: [{ begin_time: 9, text: "好", speaker_id: 1 }] }],
          }),
          { status: 200 },
        );
      }
      return new Response("no", { status: 404 });
    },
  });
  assert.deepEqual(result, [{ tStartMs: 9, text: "好", speakerId: 1 }]);
  assert.equal(
    calls.some((row) => row.url.includes("getPolicy")),
    true,
  );
  assert.equal(
    calls.some((row) => row.url.endsWith("/transcription") && row.method === "POST"),
    true,
  );
  assert.equal(
    calls.every((row) => !row.auth || row.auth === "Bearer sk-test"),
    true,
  );
  assert.equal(
    calls.some((row) => row.url.includes("getPolicy") && row.auth === "Bearer sk-test"),
    true,
  );
  const submit = calls.find((row) => row.url.endsWith("/transcription"));
  assert.equal(submit?.auth, "Bearer sk-test");
  assert.equal(JSON.parse(submit.body).parameters.diarization_enabled, true);
});

function writePcmWav(path, durationSec) {
  const dataBytes = durationSec * 16000 * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  const fd = openSync(path, "w");
  writeSync(fd, header);
  ftruncateSync(fd, 44 + dataBytes);
  closeSync(fd);
}

function asrFetch({ succeedAtPoll = 1, status = "SUCCEEDED", waitingStatus = "RUNNING" } = {}) {
  let polls = 0;
  return async (input) => {
    const url = String(input);
    if (url.includes("action=getPolicy")) {
      return new Response(
        JSON.stringify({
          data: {
            upload_host: "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload",
            upload_dir: "dashscope/tmp",
            policy: "p",
            signature: "s",
            oss_access_key_id: "id",
          },
        }),
        { status: 200 },
      );
    }
    if (url === "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload") return new Response("", { status: 200 });
    if (url.includes("/transcription")) {
      return new Response(JSON.stringify({ output: { task_id: "task-1" } }), { status: 200 });
    }
    if (url.includes("/tasks/task-1")) {
      polls += 1;
      if (status === "FAILED") {
        return new Response(JSON.stringify({ output: { task_status: "FAILED", message: "转写失败" } }), { status: 200 });
      }
      if (polls < succeedAtPoll) {
        return new Response(JSON.stringify({ output: { task_status: waitingStatus } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          output: {
            task_status: "SUCCEEDED",
            results: [{ transcription_url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json" }],
          },
        }),
        { status: 200 },
      );
    }
    if (url === "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json") {
      return new Response(JSON.stringify({ transcripts: [{ sentences: [{ begin_time: 9, text: "好", speaker_id: 1 }] }] }), {
        status: 200,
      });
    }
    return new Response("no", { status: 404 });
  };
}

test("transcribeFile keeps polling a long recording past 180 attempts", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-long-"));
  const filePath = join(root, "system.wav");
  writePcmWav(filePath, 2 * 60 * 60);
  const result = await transcribeFile({
    apiKey: "sk-test",
    filePath,
    diarize: true,
    sleep: async () => undefined,
    fetchImpl: asrFetch({ succeedAtPoll: 181 }),
  });
  assert.deepEqual(result, [{ tStartMs: 9, text: "好", speakerId: 1 }]);
});

test("transcribeFile throws on a failed task", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-fail-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  await assert.rejects(
    () =>
      transcribeFile({
        apiKey: "sk-test",
        filePath,
        diarize: false,
        sleep: async () => undefined,
        fetchImpl: asrFetch({ status: "FAILED" }),
      }),
    /转写失败/,
  );
});

test("transcribeFile stops polling when aborted", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-abort-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  const ac = new AbortController();
  let polls = 0;
  await assert.rejects(
    () =>
      transcribeFile({
        apiKey: "sk-test",
        filePath,
        diarize: false,
        signal: ac.signal,
        sleep: async () => {
          ac.abort();
        },
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/tasks/task-1")) polls += 1;
          return asrFetch({ succeedAtPoll: 50 })(input);
        },
      }),
    /已取消/,
  );
  assert.equal(polls < 50, true);
});

test("parseTranscriptionFile reads root sentences and beginTime aliases", () => {
  const rows = parseTranscriptionFile({
    sentences: [{ beginTime: 15, endTime: 40, text: "你好", speakerId: 2 }],
  });
  assert.deepEqual(rows, [{ tStartMs: 15, tEndMs: 40, text: "你好", speakerId: 2 }]);
});

test("transcribeFile throws when getPolicy is not 2xx", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-policy-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  await assert.rejects(
    () =>
      transcribeFile({
        apiKey: "sk-test",
        filePath,
        diarize: false,
        sleep: async () => undefined,
        fetchImpl: async () => new Response(JSON.stringify({ message: "凭证过期" }), { status: 403 }),
      }),
    /凭证过期/,
  );
});

test("transcribeFile throws when getPolicy omits upload_host", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-host-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  await assert.rejects(
    () =>
      transcribeFile({
        apiKey: "sk-test",
        filePath,
        diarize: false,
        sleep: async () => undefined,
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: { upload_dir: "dashscope/tmp" } }), { status: 200 }),
      }),
    /上传凭证无效/,
  );
});

test("transcribeFile throws when OSS POST is not 2xx", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-oss-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  await assert.rejects(
    () =>
      transcribeFile({
        apiKey: "sk-test",
        filePath,
        diarize: false,
        sleep: async () => undefined,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("action=getPolicy")) {
            return new Response(
              JSON.stringify({
                data: {
                  upload_host: "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload",
                  upload_dir: "dashscope/tmp",
                  policy: "p",
                  signature: "s",
                  oss_access_key_id: "id",
                },
              }),
              { status: 200 },
            );
          }
          if (url === "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload") return new Response("no", { status: 500 });
          return new Response("no", { status: 404 });
        },
      }),
    /音频上传失败/,
  );
});

test("transcribeFile throws when submit returns no task_id", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-task-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  await assert.rejects(
    () =>
      transcribeFile({
        apiKey: "sk-test",
        filePath,
        diarize: false,
        sleep: async () => undefined,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("action=getPolicy") || url === "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload") {
            return asrFetch()(input);
          }
          if (url.includes("/transcription")) {
            return new Response(JSON.stringify({ output: {} }), { status: 200 });
          }
          return new Response("no", { status: 404 });
        },
      }),
    /提交结果未知/,
  );
});

test("transcribeFile throws when SUCCEEDED has no transcription_url", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-empty-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  await assert.rejects(
    () =>
      transcribeFile({
        apiKey: "sk-test",
        filePath,
        diarize: false,
        sleep: async () => undefined,
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes("/tasks/task-1")) {
            return new Response(JSON.stringify({ output: { task_status: "SUCCEEDED", results: [{}] } }), {
              status: 200,
            });
          }
          return asrFetch()(input);
        },
      }),
    /转写结果是空的/,
  );
});

test("transcribeFile keeps polling through PENDING then SUCCEEDED", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-pending-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  const result = await transcribeFile({
    apiKey: "sk-test",
    filePath,
    diarize: false,
    sleep: async () => undefined,
    fetchImpl: asrFetch({ succeedAtPoll: 2, waitingStatus: "PENDING" }),
  });
  assert.deepEqual(result, [{ tStartMs: 9, text: "好", speakerId: 1 }]);
});

test("transcribeFile throws 转写超时 when polling never succeeds", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-timeout-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  const urls = [];
  let waited = 0;
  await assert.rejects(
    () =>
      transcribeFile({
        apiKey: "sk-test",
        filePath,
        diarize: false,
        sleep: async (ms) => {
          waited += ms;
        },
        fetchImpl: async (input) => {
          urls.push(String(input));
          return asrFetch({ succeedAtPoll: Number.POSITIVE_INFINITY })(input);
        },
      }),
    /转写超时/,
  );
  assert.equal(
    urls.some((url) => url.includes("result.json") || url.includes("transcription_url")),
    false,
  );
  assert.equal(waited >= 600_000, true);
});

test("transcribeFile reads output.result.transcription_url when results is empty", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-alt-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  const result = await transcribeFile({
    apiKey: "sk-test",
    filePath,
    diarize: false,
    sleep: async () => undefined,
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/tasks/task-1")) {
        return new Response(
          JSON.stringify({
            output: {
              task_status: "SUCCEEDED",
              result: { transcription_url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result.json" },
            },
          }),
          { status: 200 },
        );
      }
      return asrFetch()(input);
    },
  });
  assert.deepEqual(result, [{ tStartMs: 9, text: "好", speakerId: 1 }]);
});

test("transcribeFile rejects immediately when aborted during hung upload", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-hung-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  const ac = new AbortController();
  let uploadStarted;
  const uploadGate = new Promise((resolve) => {
    uploadStarted = resolve;
  });
  const pending = transcribeFile({
    apiKey: "sk-test",
    filePath,
    diarize: false,
    signal: ac.signal,
    sleep: async () => undefined,
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("action=getPolicy")) {
        return new Response(
          JSON.stringify({
            data: {
              upload_host: "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload",
              upload_dir: "dashscope/tmp",
              policy: "p",
              signature: "s",
              oss_access_key_id: "id",
            },
          }),
          { status: 200 },
        );
      }
      if (url === "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/upload") {
        assert.ok(init?.signal instanceof AbortSignal);
        uploadStarted();
        return new Promise(() => undefined);
      }
      return new Response("no", { status: 404 });
    },
  });
  await uploadGate;
  const started = Date.now();
  ac.abort();
  await assert.rejects(() => pending, /已取消/);
  assert.equal(Date.now() - started < 200, true);
});

test("transcribeFile does not fetch when already aborted", async () => {
  root = mkdtempSync(join(tmpdir(), "earshot-asr-preabort-"));
  const filePath = join(root, "system.wav");
  writeFileSync(filePath, Buffer.alloc(64));
  const ac = new AbortController();
  ac.abort();
  let fetches = 0;
  await assert.rejects(
    () =>
      transcribeFile({
        apiKey: "sk-test",
        filePath,
        diarize: false,
        signal: ac.signal,
        sleep: async () => undefined,
        fetchImpl: async () => {
          fetches += 1;
          return new Response("no", { status: 500 });
        },
      }),
    /已取消/,
  );
  assert.equal(fetches, 0);
});

for (const invalid of ['https://attacker.example/upload', 'http://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/', 'https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com.attacker.example/']) {
  test(`untrusted upload URL is rejected before sending the audio: ${invalid}`, async () => {
    root = mkdtempSync(join(tmpdir(), 'earshot-untrusted-upload-'));
    const filePath = join(root, 'audio.wav'); writeFileSync(filePath, Buffer.alloc(64));
    let uploads = 0;
    await assert.rejects(transcribeFile({ apiKey: 'fixture-only', filePath, diarize: false,
      fetchImpl: async input => {
        if (String(input).includes('action=getPolicy')) return Response.json({data: {upload_host: invalid, upload_dir: 'fixture', policy: 'fixture', signature: 'fixture'}});
        uploads++; return new Response('', {status: 500});
      } }), /地址/);
    assert.equal(uploads, 0);
  });
}

test('untrusted result URLs are rejected and all transport requests forbid redirects', async () => {
  root=mkdtempSync(join(tmpdir(),'earshot-untrusted-result-'));const filePath=join(root,'audio.wav');writeFileSync(filePath,Buffer.alloc(64));
  const cloud=asrFetch();let untrustedRequests=0;
  await assert.rejects(transcribeFile({apiKey:'fixture-only',filePath,diarize:false,sleep:async()=>{},fetchImpl:async(input,init)=>{
    assert.equal(init.redirect,'error');
    if(String(input).includes('/tasks/'))return Response.json({output:{task_status:'SUCCEEDED',result:{transcription_url:'https://attacker.example/result'}}});
    if(String(input).startsWith('https://attacker.example')){untrustedRequests++;return Response.json({});}
    return cloud(input,init);
  }}),/地址/);assert.equal(untrustedRequests,0);
});

test('the Beijing file manager upload host completes transcription without allowing redirects', async t => {
  const dir=mkdtempSync(join(tmpdir(),'earshot-provider-host-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filePath=join(dir,'audio.wav');writeFileSync(filePath,Buffer.alloc(64));let uploaded=false;
  const turns=await transcribeFile({apiKey:'fixture-only',filePath,diarize:false,sleep:async()=>{},fetchImpl:async(input,init)=>{
    assert.equal(init.redirect,'error');const url=new URL(input);
    if(url.pathname==='/api/v1/uploads')return Response.json({data:{upload_host:'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com',upload_dir:'fixture',policy:'fixture',signature:'fixture'}});
    if(url.hostname==='dashscope-file-mgr.oss-cn-beijing.aliyuncs.com'){uploaded=true;assert.equal(init.method,'POST');assert.equal((await init.body.get('file').arrayBuffer()).byteLength,64);return new Response('');}
    if(url.pathname.endsWith('/transcription'))return Response.json({output:{task_id:'fixture'}});
    if(url.pathname==='/api/v1/tasks/fixture')return Response.json({output:{task_status:'SUCCEEDED',results:[{transcription_url:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/fixture.json'}]}});
    if(url.hostname==='dashscope-result-bj.oss-cn-beijing.aliyuncs.com')return Response.json({sentences:[{begin_time:0,text:'测试'}]});
    throw Error('Unexpected endpoint');
  }});
  assert.equal(uploaded,true);assert.equal(turns[0].text,'测试');
});

for (const status of [401,429,500]) {
  test(`HTTP ${status} polling failure stops promptly and never exposes an echoed credential`, async () => {
    root=mkdtempSync(join(tmpdir(),'earshot-poll-status-'));const filePath=join(root,'audio.wav');writeFileSync(filePath,Buffer.alloc(64));
    const cloud=asrFetch();let polls=0;
    await assert.rejects(transcribeFile({apiKey:'fixture-only',filePath,diarize:false,sleep:async()=>{},fetchImpl:async(input,init)=>{
      if(String(input).includes('/tasks/')){polls++;return Response.json({message:'credential-echo-must-stay-private'},{status});}
      return cloud(input,init);
    }}),error=>String(error).includes(String(status))&&!String(error).includes('credential-echo'));
    assert.equal(polls,status === 401 ? 1 : 4);
  });
}

test('temporary poll failure recovers without submitting another paid task', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'earshot-retry-')); t.after(() => rmSync(dir, {recursive:true,force:true}));
  const filePath = join(dir, 'audio.wav'); writeFileSync(filePath, Buffer.alloc(64));
  const cloud = asrFetch(); let polls = 0; let submissions = 0;
  const rows = await transcribeFile({apiKey:'fixture-only',filePath,diarize:true,sleep:async()=>{},fetchImpl:async(input,init)=>{
    if(String(input).includes('/transcription')) submissions++;
    if(String(input).includes('/tasks/') && ++polls === 1) return new Response('',{status:503});
    return cloud(input,init);
  }});
  assert.equal(rows[0].text,'好'); assert.equal(submissions,1);
});

test('restart resumes a saved task and reuses its completed result without uploading again', async t => {
  const dir=mkdtempSync(join(tmpdir(),'earshot-resume-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filePath=join(dir,'audio.wav'), checkpointPath=join(dir,'task.json'); writeFileSync(filePath,Buffer.alloc(64));
  const cloud=asrFetch(); const ac=new AbortController();
  await assert.rejects(transcribeFile({apiKey:'fixture-only',filePath,checkpointPath,diarize:true,signal:ac.signal,sleep:async()=>{ac.abort();},fetchImpl:cloud}),/已取消/);
  const resume=async(input,init)=>{
    assert.ok(!String(input).includes('/uploads') && init.method !== 'POST','resumption must not upload or submit');
    return cloud(input,init);
  };
  const rows=await transcribeFile({apiKey:'fixture-only',filePath,checkpointPath,diarize:true,sleep:async()=>{},fetchImpl:resume});
  assert.equal(rows[0].text,'好');
  assert.deepEqual(await transcribeFile({apiKey:'fixture-only',filePath,checkpointPath,diarize:true,fetchImpl:async()=>{throw Error('completed result must be local');}}),rows);
});

test('malformed cloud results fail explicitly while a no-words subtask is valid silence', async t => {
  assert.throws(()=>parseTranscriptionFile({unexpected:[]}),/格式/);
  const dir=mkdtempSync(join(tmpdir(),'earshot-silence-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filePath=join(dir,'audio.wav');writeFileSync(filePath,Buffer.alloc(64));const cloud=asrFetch();
  assert.deepEqual(await transcribeFile({apiKey:'fixture-only',filePath,diarize:true,sleep:async()=>{},fetchImpl:async(input,init)=>{
    if(String(input).includes('/tasks/'))return Response.json({output:{task_status:'FAILED',results:[{subtask_status:'FAILED',code:'ASR_RESPONSE_HAVE_NO_WORDS'}]}});
    return cloud(input,init);
  }}),[]);
});

test('a hung response body times out and uncertain submission is not automatically repeated', async t => {
  const dir=mkdtempSync(join(tmpdir(),'earshot-hung-body-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filePath=join(dir,'audio.wav'),checkpointPath=join(dir,'task.json');writeFileSync(filePath,Buffer.alloc(64));const cloud=asrFetch();
  await assert.rejects(transcribeFile({apiKey:'fixture-only',filePath,checkpointPath,diarize:false,requestTimeoutMs:10,fetchImpl:async(input,init)=>{
    if(String(input).includes('/transcription'))return new Response(new ReadableStream({start(){}}));
    return cloud(input,init);
  }}),/提交结果未知/);
  await assert.rejects(transcribeFile({apiKey:'fixture-only',filePath,checkpointPath,diarize:false,fetchImpl:async()=>{assert.fail('must not resubmit');}}),/提交结果未知/);
});

test('expired saved tasks fail clearly then permit an explicit retry to submit fresh audio', async t => {
  const dir=mkdtempSync(join(tmpdir(),'earshot-expired-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filePath=join(dir,'audio.wav'),checkpointPath=join(dir,'task.json');writeFileSync(filePath,Buffer.alloc(64));const cloud=asrFetch();const ac=new AbortController();
  await assert.rejects(transcribeFile({apiKey:'fixture-only',filePath,checkpointPath,diarize:false,signal:ac.signal,sleep:async()=>ac.abort(),fetchImpl:cloud}));
  await assert.rejects(transcribeFile({apiKey:'fixture-only',filePath,checkpointPath,diarize:false,sleep:async()=>{},fetchImpl:async()=>new Response('',{status:404})}),/过期/);
  const rows=await transcribeFile({apiKey:'fixture-only',filePath,checkpointPath,diarize:false,retryUncertainSubmission:true,sleep:async()=>{},fetchImpl:cloud});
  assert.equal(rows[0].text,'好');
});

test('saved diagnostics identify the failed stage without storing API keys or provider messages', async t => {
  const dir=mkdtempSync(join(tmpdir(),'earshot-diagnostics-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filePath=join(dir,'audio.wav'),checkpointPath=join(dir,'task.json');writeFileSync(filePath,Buffer.alloc(64));const cloud=asrFetch();
  await assert.rejects(transcribeFile({apiKey:'fixture-private-key',filePath,checkpointPath,diarize:false,sleep:async()=>{},fetchImpl:async(input,init)=>{
    if(String(input).includes('/tasks/'))return Response.json({message:'fixture-private-key'},{status:503});
    return cloud(input,init);
  }}));
  const {readFileSync}=await import('node:fs');const raw=readFileSync(checkpointPath,'utf8'),journal=JSON.parse(raw);
  assert.ok(!raw.includes('fixture-private-key'));assert.equal(journal.diagnostics.at(-1).stage,'poll');assert.equal(journal.diagnostics.at(-1).httpStatus,503);
});

for (const bad of ['{', {}, {stage:'bogus'}, {stage:'poll'}, {stage:'done',rows:[{text:'ok',tStartMs:-1}]}]) {
  test(`damaged checkpoint blocks every network call: ${JSON.stringify(bad)}`, async t => {
    const {audioKey}=await import('./asr-checkpoint.ts');
    const dir=mkdtempSync(join(tmpdir(),'earshot-corrupt-checkpoint-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const filePath=join(dir,'audio.wav'),checkpointPath=join(dir,'task.json');writeFileSync(filePath,Buffer.alloc(64));
    const key=await audioKey(filePath,true);
    writeFileSync(checkpointPath,typeof bad==='string'?bad:JSON.stringify({key,...bad}));
    let calls=0;
    await assert.rejects(transcribeFile({apiKey:'fixture-only',filePath,checkpointPath,diarize:true,fetchImpl:async()=>{calls++;throw Error('unexpected');}}),/任务记录损坏/);
    assert.equal(calls,0);
  });
}

for (const change of ['audio','diarize']) test(`checkpoint identity isolates a changed ${change}`, async t => {
  const dir=mkdtempSync(join(tmpdir(),'earshot-changed-source-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filePath=join(dir,'audio.wav'),checkpointPath=join(dir,'task.json');writeFileSync(filePath,Buffer.alloc(64));
  let submissions=0;const cloud=asrFetch();
  const fetchImpl=async(input,init)=>{if(String(input).endsWith('/transcription'))submissions++;return cloud(input,init);};
  const run=diarize=>transcribeFile({apiKey:'fixture-only',filePath,checkpointPath,diarize,sleep:async()=>{},fetchImpl});
  await run(true);await run(true);assert.equal(submissions,1);
  if(change==='audio')writeFileSync(filePath,Buffer.alloc(64,1));
  await run(change==='diarize'?false:true);assert.equal(submissions,2);
});

for (const stage of ['policy','poll','download']) for (const failure of ['network','timeout','http']) {
  test(`${stage} GET recovers from ${failure} without duplicate paid submission`, async t => {
    const dir=mkdtempSync(join(tmpdir(),'earshot-get-recovery-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
    const filePath=join(dir,'audio.wav');writeFileSync(filePath,Buffer.alloc(64));
    const cloud=asrFetch();let attempts=0,submissions=0;const waits=[];
    const result=await transcribeFile({apiKey:'fixture-only',filePath,diarize:true,requestTimeoutMs:10,sleep:async ms=>{waits.push(ms);},fetchImpl:async(input,init)=>{
      const url=String(input);if(url.endsWith('/transcription'))submissions++;
      const target=stage==='policy'?url.includes('getPolicy'):stage==='poll'?url.includes('/tasks/'):url.startsWith('https://dashscope-result-');
      if(target&&++attempts===1){
        if(failure==='network')throw Error('connection reset');
        if(failure==='timeout')return new Promise(()=>{});
        return new Response('',{status:429,headers:{'Retry-After':'999999'}});
      }
      return cloud(input,init);
    }});
    assert.equal(result[0].text,'好');assert.equal(attempts,2);assert.equal(submissions,1);
    assert.ok(waits.every(ms=>ms<=30000));if(failure==='http')assert.ok(waits.includes(30000));
  });
}

test('canceling during backoff settles without sending a retry', async t => {
  const dir=mkdtempSync(join(tmpdir(),'earshot-backoff-abort-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filePath=join(dir,'audio.wav');writeFileSync(filePath,Buffer.alloc(64));let calls=0;const ac=new AbortController();
  await assert.rejects(transcribeFile({apiKey:'fixture-only',filePath,diarize:true,signal:ac.signal,
    fetchImpl:async()=>{calls++;return new Response('',{status:503});},sleep:async()=>{ac.abort();}}),/已取消/);
  assert.equal(calls,1);
});

for(const failure of ['network','http']) test(`unknown POST ${failure} requires explicit retry, which submits once`,async t=>{
  const dir=mkdtempSync(join(tmpdir(),'earshot-unknown-submit-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filePath=join(dir,'audio.wav'),checkpointPath=join(dir,'task.json');writeFileSync(filePath,Buffer.alloc(64));
  const cloud=asrFetch();let submissions=0;
  const opts={apiKey:'fixture-only',filePath,checkpointPath,diarize:true,sleep:async()=>{},fetchImpl:async(input,init)=>{
    if(String(input).endsWith('/transcription')){submissions++;if(failure==='network')throw Error('connection lost');return new Response('',{status:503});}
    return cloud(input,init);
  }};
  await assert.rejects(transcribeFile(opts),/提交结果未知/);
  await assert.rejects(transcribeFile({...opts,fetchImpl:async()=>assert.fail('reopening must not submit')}),/提交结果未知/);
  assert.equal(submissions,1);
  await transcribeFile({...opts,retryUncertainSubmission:true,fetchImpl:async(input,init)=>{if(String(input).endsWith('/transcription'))submissions++;return cloud(input,init);}});
  assert.equal(submissions,2);
});

test('a terminal paid task cannot be automatically submitted again on restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'earshot-terminal-resume-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filePath=join(dir,'audio.wav'),checkpointPath=join(dir,'task.json');writeFileSync(filePath,Buffer.alloc(64));const cloud=asrFetch();
  await assert.rejects(transcribeFile({apiKey:'fixture-only',filePath,checkpointPath,diarize:true,sleep:async()=>{},fetchImpl:async(input,init)=>{
    if(String(input).includes('/tasks/'))return Response.json({output:{task_status:'FAILED'}});
    return cloud(input,init);
  }}),/转写失败/);
  let calls=0;
  await assert.rejects(transcribeFile({apiKey:'fixture-only',filePath,checkpointPath,diarize:true,sleep:async()=>{},fetchImpl:async()=>{calls++;throw Error('must not resubmit');}}),/手动重试/);
  assert.equal(calls,0);
});

test('a completed text result with incomplete speakers is reused after restart without payment',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'earshot-incomplete-resume-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const filePath=join(dir,'audio.wav'),checkpointPath=join(dir,'task.json');writeFileSync(filePath,Buffer.alloc(64));const cloud=asrFetch();
  const opts={apiKey:'fixture-only',filePath,checkpointPath,diarize:true,sleep:async()=>{}};
  const expected=await transcribeFile({...opts,fetchImpl:async(input,init)=>{
    if(String(input).startsWith('https://dashscope-result-'))return Response.json({sentences:[{begin_time:0,end_time:1000,text:'保留的文字'}]});
    return cloud(input,init);
  }});
  let calls=0;
  const resumed=await transcribeFile({...opts,fetchImpl:async()=>{calls++;throw Error('must not resubmit');}});
  assert.deepEqual(resumed,expected);assert.equal(calls,0);
});
