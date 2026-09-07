import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import type { Track, TranscriptTurn } from "../../shared/types";
import { wavDurationSec } from "../store/wav.ts";
import { FILE_MODEL, HTTP_BASE } from "./models.ts";
import { speakerFromId } from "../store/transcript.ts";

export type FileAsrTurn = {
  tStartMs: number;
  tEndMs?: number;
  text: string;
  speakerId?: unknown;
};

export type FileAsrFetch = (input: string, init?: RequestInit) => Promise<Response>;

export function parseTranscriptionFile(raw: unknown): FileAsrTurn[] {
  const sentences = collectSentences(raw);
  const turns: FileAsrTurn[] = [];
  for (const row of sentences) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    const tStartMs =
      typeof item.begin_time === "number"
        ? item.begin_time
        : typeof item.beginTime === "number"
          ? item.beginTime
          : 0;
    const tEndRaw =
      typeof item.end_time === "number"
        ? item.end_time
        : typeof item.endTime === "number"
          ? item.endTime
          : undefined;
    const tEndMs = typeof tEndRaw === "number" && tEndRaw > tStartMs ? tEndRaw : undefined;
    turns.push({
      tStartMs,
      ...(tEndMs !== undefined ? { tEndMs } : {}),
      text,
      speakerId: item.speaker_id ?? item.speakerId,
    });
  }
  return turns;
}

function collectSentences(raw: unknown): unknown[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const transcripts = Array.isArray(root.transcripts) ? root.transcripts : [];
  if (transcripts[0] && typeof transcripts[0] === "object") {
    const first = transcripts[0] as Record<string, unknown>;
    if (Array.isArray(first.sentences)) return first.sentences;
  }
  if (Array.isArray(root.sentences)) return root.sentences;
  return [];
}

export function toSessionTurns(rows: FileAsrTurn[], track: Track, diarize: boolean): TranscriptTurn[] {
  return rows.map((row, index) => ({
    id: `${track}-${index}-${row.tStartMs}`,
    track,
    speaker: track === "you" ? "你" : diarize ? speakerFromId(row.speakerId) : "对方",
    tStartMs: row.tStartMs,
    ...(row.tEndMs !== undefined ? { tEndMs: row.tEndMs } : {}),
    text: row.text,
  }));
}

function resourceUrl(raw: string, kind: "file" | "result"): string {
  try {
    const url = new URL(raw);
    const hosts = kind === "file"
      ? ["dashscope-file-bj.oss-cn-beijing.aliyuncs.com", "dashscope-file-mgr.oss-cn-beijing.aliyuncs.com"]
      : ["dashscope-result-bj.oss-cn-beijing.aliyuncs.com"];
    if (url.protocol === "https:" && hosts.includes(url.hostname)
      && !url.username && !url.password && !url.port) return url.href;
  } catch { /* rejected below */ }
  throw new Error("服务返回了无效的文件地址");
}

export async function transcribeFile(opts: {
  apiKey: string;
  filePath: string;
  diarize: boolean;
  fetchImpl?: FileAsrFetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<FileAsrTurn[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  function cancelledError(): Error {
    return new Error("已取消");
  }
  function throwIfAborted(): void {
    if (opts.signal?.aborted) throw cancelledError();
  }
  function abortable<T>(work: Promise<T>): Promise<T> {
    const signal = opts.signal;
    if (!signal) return work;
    if (signal.aborted) return Promise.reject(cancelledError());
    return new Promise((resolve, reject) => {
      const onAbort = (): void => reject(cancelledError());
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(signal.aborted || (err instanceof Error && err.name === "AbortError") ? cancelledError() : err);
        },
      );
    });
  }
  function callFetch(input: string, init?: RequestInit): Promise<Response> {
    throwIfAborted();
    return abortable(fetchImpl(input, { ...init, redirect: "error", signal: opts.signal }));
  }
  async function sleepOrAbort(ms: number): Promise<void> {
    throwIfAborted();
    await abortable(sleep(ms));
    throwIfAborted();
  }
  throwIfAborted();
  const headers = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
  };
  const policyRes = await callFetch(
    `${HTTP_BASE}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(FILE_MODEL)}`,
    { headers },
  );
  const policyJson = (await policyRes.json()) as {
    data?: Record<string, unknown>;
    message?: string;
  };
  const policy = policyJson.data ?? {};
  const uploadHost = String(policy.upload_host ?? policy.uploadHost ?? "");
  const uploadDir = String(policy.upload_dir ?? policy.uploadDir ?? "");
  if (!policyRes.ok || !uploadHost || !uploadDir) {
    throw new Error(policyJson.message || "上传凭证无效");
  }
  const filename = basename(opts.filePath) || "audio.wav";
  const objectKey = `${uploadDir.replace(/\/$/, "")}/${randomUUID()}-${filename}`;
  const form = new FormData();
  form.set("OSSAccessKeyId", String(policy.oss_access_key_id ?? policy.ossAccessKeyId ?? ""));
  form.set("Signature", String(policy.signature ?? ""));
  form.set("policy", String(policy.policy ?? ""));
  form.set("x-oss-object-acl", String(policy.x_oss_object_acl ?? policy.xOssObjectAcl ?? "private"));
  form.set("x-oss-forbid-overwrite", String(policy.x_oss_forbid_overwrite ?? policy.xOssForbidOverwrite ?? "true"));
  form.set("key", objectKey);
  form.set("success_action_status", "200");
  throwIfAborted();
  form.set("file", await openAsBlob(opts.filePath), filename);
  const uploadRes = await callFetch(resourceUrl(uploadHost, "file"), { method: "POST", body: form });
  if (!uploadRes.ok) throw new Error("音频上传失败");

  const submitRes = await callFetch(`${HTTP_BASE}/api/v1/services/audio/asr/transcription`, {
    method: "POST",
    headers: {
      ...headers,
      "X-DashScope-Async": "enable",
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify({
      model: FILE_MODEL,
      input: { file_urls: [`oss://${objectKey}`] },
      parameters: {
        channel_id: [0],
        diarization_enabled: opts.diarize,
      },
    }),
  });
  const submitJson = (await submitRes.json()) as { output?: { task_id?: string } };
  const taskId = submitJson.output?.task_id;
  if (!submitRes.ok || !taskId) throw new Error("转写任务没提交上");

  const audioSec = wavDurationSec(opts.filePath) ?? 0;
  const deadlineMs = Math.max(10 * 60, audioSec * 2) * 1000;
  let waited = 0;
  let interval = 2000;
  while (waited < deadlineMs) {
    throwIfAborted();
    await sleepOrAbort(interval);
    throwIfAborted();
    waited += interval;
    if (waited >= 60_000) interval = 5000;
    const pollRes = await callFetch(`${HTTP_BASE}/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers });
    if (!pollRes.ok) throw new Error(`转写服务请求失败：HTTP ${pollRes.status}`);
    const pollJson = (await pollRes.json()) as {
      output?: {
        task_status?: string;
        results?: Array<{ transcription_url?: string; subtask_status?: string }>;
        result?: { transcription_url?: string };
        code?: string;
        message?: string;
      };
    };
    const status = pollJson.output?.task_status;
    if (status === "FAILED") {
      // A wordless track is a valid empty result; processing the other track must continue.
      const noWords = "ASR_RESPONSE_HAVE_NO_WORDS";
      if (pollJson.output?.code === noWords || pollJson.output?.message === noWords) return [];
      throw new Error(pollJson.output?.message || "转写失败");
    }
    if (status !== "SUCCEEDED") continue;
    const url =
      pollJson.output?.results?.find((row) => row.transcription_url)?.transcription_url ??
      pollJson.output?.result?.transcription_url;
    if (!url) throw new Error("转写结果是空的");
    const fileRes = await callFetch(resourceUrl(url, "result"));
    if (!fileRes.ok) throw new Error("转写结果未能下载");
    return parseTranscriptionFile(await fileRes.json());
  }
  throw new Error("转写超时");
}
