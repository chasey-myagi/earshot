import { randomUUID } from "node:crypto";
import { hotwordParameters, hotwordRevision } from "./hotwords.ts";
import { parseUsage, recordUsage } from "./usage.ts";
import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import type { Track, TranscriptTurn } from "../../shared/types";
import { wavDurationSec } from "../store/wav.ts";
import { FILE_MODEL, HTTP_BASE } from "./models.ts";
import { speakerFromId } from "../store/transcript.ts";
import { audioKey, readCheckpoint, saveCheckpoint, type AsrCheckpoint } from "./asr-checkpoint.ts";

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
    const speakerId = item.speaker_id ?? item.speakerId;
    turns.push({
      tStartMs,
      ...(tEndMs !== undefined ? { tEndMs } : {}),
      text,
      ...(speakerId !== undefined ? { speakerId } : {}),
    });
  }
  return turns;
}

function collectSentences(raw: unknown): unknown[] {
  if (!raw || typeof raw !== "object") throw new Error("转写结果格式无效");
  const root = raw as Record<string, unknown>;
  const transcripts = Array.isArray(root.transcripts) ? root.transcripts : [];
  if (transcripts[0] && typeof transcripts[0] === "object") {
    const first = transcripts[0] as Record<string, unknown>;
    if (Array.isArray(first.sentences)) return first.sentences;
  }
  if (Array.isArray(root.sentences)) return root.sentences;
  throw new Error("转写结果格式无效");
}

export function toSessionTurns(rows: FileAsrTurn[], track: Track, diarize: boolean, sharedMicrophone = false): TranscriptTurn[] {
  return rows.map((row, index) => ({
    id: `${track}-${index}-${row.tStartMs}`,
    track,
    speaker: track === "you" ? sharedMicrophone
      ? diarize && speakerFromId(row.speakerId) !== "对方" ? speakerFromId(row.speakerId).replace(/^小 /, "现场 ") : "现场"
      : "你" : diarize ? speakerFromId(row.speakerId) : "对方",
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
  checkpointPath?: string;
  inputKey?: string;
  retryUncertainSubmission?: boolean;
  requestTimeoutMs?: number;
}): Promise<FileAsrTurn[]> {
  const vocabulary = hotwordParameters(FILE_MODEL, opts.apiKey);
  const vocabularyRevision = hotwordRevision();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let requestStage = "policy";
  let recordFailure: (kind: "http" | "timeout" | "network", status?: number, requestId?: string | null) => void = () => {};
  function cancelledError(): Error {
    return new Error("已取消");
  }
  function throwIfAborted(): void {
    if (opts.signal?.aborted) throw cancelledError();
  }
  function abortable<T>(work: Promise<T>, signal = opts.signal): Promise<T> {
    if (!signal) return work;
    if (signal.aborted) return Promise.reject(cancelledError());
    return new Promise((resolve, reject) => {
      const onAbort = (): void => reject(opts.signal?.aborted ? cancelledError() : signal.reason ?? cancelledError());
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
  async function callFetch(input: string, init?: RequestInit): Promise<Response> {
    const retryable = !init?.method || init.method === "GET";
    for (let attempt = 0; ; attempt++) {
      throwIfAborted();
      let response: Response;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new Error("转写请求超时")), opts.requestTimeoutMs ?? 120_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;
      try {
        response = await abortable((async () => {
          const raw = await fetchImpl(input, { ...init, redirect: "error", signal });
          const body = await raw.arrayBuffer();
          return new Response([204, 205, 304].includes(raw.status) ? null : body,
            { status: raw.status, headers: raw.headers });
        })(), signal);
      } catch (err) {
        throwIfAborted();
        recordFailure(timeout.signal.aborted ? "timeout" : "network");
        if (!retryable || attempt >= 3) throw err;
        await sleepOrAbort(1000 * 2 ** attempt);
        continue;
      } finally { clearTimeout(timer); }
      if (!response.ok) recordFailure("http", response.status, response.headers.get("x-request-id"));
      if (!retryable || attempt >= 3 || ![429, 500, 502, 503, 504].includes(response.status)) return response;
      const retryAfter = response.headers.get("retry-after");
      const delay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000
        : retryAfter && Number.isFinite(Date.parse(retryAfter)) ? Math.max(0, Date.parse(retryAfter) - Date.now())
        : 1000 * 2 ** attempt * (0.75 + Math.random() * 0.5);
      await response.body?.cancel();
      await sleepOrAbort(Math.min(30_000, delay));
    }
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
  const key = opts.inputKey ?? (opts.checkpointPath ? await audioKey(opts.filePath, opts.diarize, opts.signal) : "");
  throwIfAborted();
  const saved = readCheckpoint(opts.checkpointPath, key);
  if (saved?.stage === "done") return saved.rows!;
  if (saved?.stage === "failed" && !opts.retryUncertainSubmission) {
    // A known partial transcript remains usable; starting another paid task is a user action.
    if (saved.rows) return saved.rows;
    throw new Error("云端任务未完成，请手动重试");
  }
  if (saved?.stage === "submitting" && !opts.retryUncertainSubmission) throw new Error("提交结果未知");
  let journal: AsrCheckpoint = saved ?? { key, stage: "upload", updatedAt: Date.now() };
  const checkpoint = (stage: AsrCheckpoint["stage"], extra: Partial<AsrCheckpoint> = {}) => {
    journal = { ...journal, stage, updatedAt: Date.now(), ...extra };
    saveCheckpoint(opts.checkpointPath, journal);
  };
  recordFailure = (kind, httpStatus, requestId) => {
    const safeId = requestId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId) && !requestId.includes(opts.apiKey) ? requestId : undefined;
    checkpoint(journal.stage, { diagnostics: [...(journal.diagnostics ?? []), {
      at: Date.now(), stage: requestStage, kind, httpStatus, requestId: safeId,
    }].slice(-12) });
  };
  let taskId = saved?.stage === "poll" ? saved.taskId : undefined;
  if (!taskId) {
    checkpoint("upload", { taskId: undefined, rows: undefined });
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
    requestStage = "upload";
    const uploadRes = await callFetch(resourceUrl(uploadHost, "file"), { method: "POST", body: form });
    if (!uploadRes.ok) throw new Error("音频上传失败");

    checkpoint("submitting", { usageId: randomUUID(), usageAt: Date.now(),
      hotwordRevision: vocabularyRevision, vocabularyId: vocabulary.vocabulary_id });
    recordUsage({ id: journal.usageId!, at: journal.usageAt!, model: FILE_MODEL, kind: "file-asr",
      audioSeconds: wavDurationSec(opts.filePath) ?? undefined, measurement: "local", outcome: "uncertain" });
    requestStage = "submit";
    try {
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
            ...vocabulary,
            channel_id: [0],
            diarization_enabled: opts.diarize,
          },
        }),
      });
      if (!submitRes.ok && submitRes.status < 500) {
        checkpoint("failed");
        throw new Error(`转写服务请求失败：HTTP ${submitRes.status}`);
      }
      const submitJson = (await submitRes.json()) as { output?: { task_id?: string } };
      taskId = typeof submitJson.output?.task_id === "string" ? submitJson.output.task_id : undefined;
      if (!submitRes.ok || !taskId) throw new Error("提交结果未知");
    } catch (err) {
      throwIfAborted();
      if (journal.stage === "submitting") throw new Error("提交结果未知");
      throw err;
    }
    try { checkpoint("poll", { taskId }); }
    catch { throw new Error("提交结果未知"); }
  }

  const audioSec = wavDurationSec(opts.filePath) ?? 0;
  const deadlineMs = Math.max(10 * 60, audioSec * 2) * 1000;
  const startedAt = Date.now();
  let waited = 0;
  let interval = 2000;
  while (Math.max(waited, Date.now() - startedAt) < deadlineMs) {
    throwIfAborted();
    await sleepOrAbort(interval);
    throwIfAborted();
    waited += interval;
    if (waited >= 60_000) interval = 5000;
    requestStage = "poll";
    const pollRes = await callFetch(`${HTTP_BASE}/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers });
    if ([404, 410].includes(pollRes.status)) {
      checkpoint("failed", { taskId });
      throw new Error("云端任务已过期");
    }
    if (!pollRes.ok) throw new Error(`转写服务请求失败：HTTP ${pollRes.status}`);
    const pollJson = (await pollRes.json()) as {
      output?: {
        task_status?: string;
        results?: Array<{ transcription_url?: string; subtask_status?: string; code?: string; message?: string }>;
        result?: { transcription_url?: string };
        code?: string;
        message?: string;
      };
    };
    const status = pollJson.output?.task_status;
    if (status === "FAILED") {
      // A wordless track is a valid empty result; processing the other track must continue.
      const noWords = "ASR_RESPONSE_HAVE_NO_WORDS";
      if (pollJson.output?.code === noWords || pollJson.output?.message === noWords ||
        (pollJson.output?.results?.length === 1 && pollJson.output.results[0]?.code === noWords)) {
        checkpoint("done", { taskId, rows: [] }); return [];
      }
      checkpoint("failed", { taskId });
      throw new Error(pollJson.output?.message || "转写失败");
    }
    if (status !== "SUCCEEDED") continue;
    const metered = parseUsage(pollJson);
    recordUsage({ id: journal.usageId ?? taskId, at: journal.usageAt ?? journal.updatedAt, model: FILE_MODEL, kind: "file-asr",
      audioSeconds: metered.audioSeconds ?? audioSec, measurement: metered.audioSeconds === undefined ? "local" : "provider", outcome: "succeeded" });
    const url =
      pollJson.output?.results?.find((row) => row.transcription_url)?.transcription_url ??
      pollJson.output?.result?.transcription_url;
    if (!url) throw new Error("转写结果是空的");
    requestStage = "download";
    const fileRes = await callFetch(resourceUrl(url, "result"));
    if ([403, 404, 410].includes(fileRes.status)) {
      checkpoint("failed", { taskId });
      throw new Error("云端结果已过期");
    }
    if (!fileRes.ok) throw new Error("转写结果未能下载");
    const rows = parseTranscriptionFile(await fileRes.json());
    checkpoint(opts.diarize && rows.some(row => speakerFromId(row.speakerId) === "对方") ? "failed" : "done", { taskId, rows });
    return rows;
  }
  throw new Error("转写超时");
}
