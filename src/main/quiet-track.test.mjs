// An explicitly wordless cloud result is an empty track. The other track still produces results; unrelated provider errors still fail.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processSession } from "./jobs/post.ts";
import { transcribeFile } from "./providers/file-asr.ts";
import { createSessionStore } from "./store/sessions.ts";
import { createPcmWavWriter } from "./store/wav.ts";

const noWords = { code: "ASR_RESPONSE_HAVE_NO_WORDS", message: "ASR_RESPONSE_HAVE_NO_WORDS" };
const otherFailure = { code: "INTERNAL_ERROR", message: "服务暂不可用" };
const systemTurn = { track: "other", speaker: "小 A", tStartMs: 100, tEndMs: 900, text: "系统轨发言" };
const micTurn = { track: "you", speaker: "你", tStartMs: 100, tEndMs: 900, text: "麦克风发言" };

function fixture(t, micFailure = null) {
  const root = mkdtempSync(join(tmpdir(), "earshot-quiet-track-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createSessionStore(root);
  const { id } = store.createRecording();
  const dir = store.sessionDir(id);
  const originals = new Map();
  for (const [name, amplitude] of [["mic.wav", 1], ["system.wav", 8000]]) {
    const pcm = Buffer.alloc(16000 * 2);
    for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(amplitude * Math.sin(i * 0.2)), i * 2);
    const writer = createPcmWavWriter(join(dir, name));
    writer.write(pcm);
    writer.close();
    originals.set(name, readFileSync(join(dir, name)));
  }
  store.finalize(id, "complete");

  // Only the external HTTP boundary is replaced. No provider/job/store collaborator is mocked.
  const uploads = new Map();
  const json = (body) => Response.json(body);
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/uploads") {
      return json({ data: { upload_host: "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/audio", upload_dir: "test-audio",
        policy: "test-policy", signature: "test-signature", oss_access_key_id: "test-id" } });
    }
    if (url.href === "https://dashscope-file-bj.oss-cn-beijing.aliyuncs.com/audio") {
      const file = init.body.get("file");
      await file.arrayBuffer();
      uploads.set(`oss://${init.body.get("key")}`, file.name);
      return new Response("");
    }
    if (url.pathname === "/api/v1/services/audio/asr/transcription") {
      const name = uploads.get(JSON.parse(init.body).input.file_urls[0]);
      if (!name) throw new Error("Test cloud received an unuploaded audio URL");
      return json({ output: { task_id: name } });
    }
    if (url.pathname.startsWith("/api/v1/tasks/")) {
      const name = url.pathname.split("/").at(-1);
      if (name === "mic.wav" && micFailure) {
        return json({ output: { task_status: "FAILED", ...micFailure } });
      }
      return json({ output: { task_status: "SUCCEEDED",
        results: [{ subtask_status: "SUCCEEDED", transcription_url: `https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/${name}.json` }] } });
    }
    if (url.hostname === "dashscope-result-bj.oss-cn-beijing.aliyuncs.com") {
      return json({ transcripts: [{ sentences: [{ begin_time: 100, end_time: 900, speaker_id: 0,
        text: url.pathname === "/mic.wav.json" ? micTurn.text : systemTurn.text }] }] });
    }
    throw new Error(`Unexpected test cloud URL: ${url.href}`);
  });
  return { store, id, dir, originals };
}

function snapshot({ store, id, dir, originals }) {
  const { jobs } = store.readSession(id);
  const readArtifact = (job) => job.current ? JSON.parse(readFileSync(join(dir, job.current), "utf8")) : null;
  return {
    refinedStatus: jobs.refined.status,
    speakersStatus: jobs.speakers.status,
    turns: readArtifact(jobs.refined)?.turns.map(({ id: _id, ...turn }) => turn) ?? null,
    speakers: readArtifact(jobs.speakers)?.speakers ?? null,
    originalAudioUnchanged: [...originals].every(([name, bytes]) => readFileSync(join(dir, name)).equals(bytes)),
  };
}

async function process(f) {
  await processSession({ apiKey: "sk-test", store: f.store, sessionId: f.id, mode: "all" });
  return snapshot(f);
}

test("transcribeFile returns empty turns for an explicit cloud no-words result", async (t) => {
  const f = fixture(t, noWords);
  const outcome = await transcribeFile({ apiKey: "sk-test", filePath: join(f.dir, "mic.wav"), diarize: false })
    .then((turns) => ({ turns }), (err) => ({ error: err.message }));
  assert.deepEqual(outcome, { turns: [] });
});

test("a cloud-wordless microphone preserves the system transcript and speakers", async (t) => {
  const f = fixture(t, noWords);
  assert.deepEqual(await process(f), {
    refinedStatus: "done", speakersStatus: "done", turns: [systemTurn], speakers: ["小 A"], originalAudioUnchanged: true,
  });
});

test("ordinary cloud speech results preserve both tracks and speaker artifacts", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await process(f), {
    refinedStatus: "done", speakersStatus: "done", turns: [micTurn, systemTurn], speakers: ["小 A"], originalAudioUnchanged: true,
  });
});

test("other cloud failures remain failures and preserve original audio", async (t) => {
  const f = fixture(t, otherFailure);
  await assert.rejects(
    transcribeFile({ apiKey: "sk-test", filePath: join(f.dir, "mic.wav"), diarize: false }),
    /服务暂不可用/,
  );
  assert.deepEqual(await process(f), {
    refinedStatus: "failed", speakersStatus: "done", turns: [systemTurn], speakers: ["小 A"], originalAudioUnchanged: true,
  });
});
