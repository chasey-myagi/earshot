import type { RealtimeFailureCategory } from "../../shared/types";
import { randomUUID } from "node:crypto";
import { hotwordParameters } from "./hotwords.ts";
import { parseUsage, recordUsage } from "./usage.ts";
import { REALTIME_MODEL, REALTIME_URL } from "./models.ts";

export type RealtimeSentence = {
  sentenceId: string;
  text: string;
  tStartMs: number;
  final: boolean;
};

export type RealtimeSocket = {
  send: (data: string | Buffer) => void;
  close: () => void;
  onOpen: (fn: () => void) => void;
  onMessage: (fn: (data: string) => void) => void;
  onError: (fn: (err: Error) => void) => void;
  onClose: (fn: () => void) => void;
};

export type SocketConnect = (url: string, headers: Record<string, string>) => RealtimeSocket;

const QUEUE_CAP = 1000;
export type RealtimeFailure = { category: RealtimeFailureCategory; retryable: boolean; taskId: string; providerCode?: string };
// Explicit provider codes are authoritative: rate quota is throttling, not account balance.
const PROVIDER_FAILURE_CATEGORIES: Record<string, RealtimeFailureCategory> = {
  InvalidApiKey: "auth", Unauthorized: "auth", AccessDenied: "auth", PermissionDenied: "auth", "401": "auth", "403": "auth",
  InsufficientBalance: "quota", QuotaExceeded: "quota", "402": "quota",
  InvalidParameter: "invalid-request", InvalidParameterValue: "invalid-request", InvalidRequest: "invalid-request", BadRequest: "invalid-request", "400": "invalid-request",
  RequestTimeout: "provider-timeout", TaskTimeout: "provider-timeout", ResponseTimeout: "provider-timeout", "408": "provider-timeout", "504": "provider-timeout",
  Throttling: "rate-limit", "Throttling.RateQuota": "rate-limit", TooManyRequests: "rate-limit", "429": "rate-limit",
  InternalError: "server", InternalServerError: "server", ServiceUnavailable: "server", "500": "server", "502": "server", "503": "server",
};

// Unknown provider strings are used only for classification, never diagnostic or UI text.
export function classifyRealtimeFailure(code = "", message = ""): Omit<RealtimeFailure, "taskId"> {
  const known = Object.hasOwn(PROVIDER_FAILURE_CATEGORIES, code);
  let category: RealtimeFailureCategory = known ? PROVIDER_FAILURE_CATEGORIES[code]! : "provider";
  if (!known) {
    const value = `${code} ${message}`.toLowerCase();
    if (/invalidapikey|invalid_api_key|unauthorized|authentication|accessdenied|permissiondenied|\b401\b|\b403\b/.test(value)) category = "auth";
    else if (/insufficient|balance|arrear|payment|\b402\b/.test(value)) category = "quota";
    else if (/invalidparameter|invalid_parameter|invalidrequest|invalid_request|badrequest|unsupported|\b400\b/.test(value)) category = "invalid-request";
    else if (/timeout|timed.?out|\b408\b|\b504\b/.test(value)) category = "provider-timeout";
    else if (/throttl|ratelimit|rate.?limit|too.?many|\b429\b/.test(value)) category = "rate-limit";
    else if (/quota/.test(value)) category = "quota";
    else if (/internalerror|internal.?server|serviceunavailable|service.?unavailable|servererror|\b50[0-9]\b/.test(value)) category = "server";
  }
  return { category, retryable: ["provider-timeout", "server", "rate-limit"].includes(category), ...(known ? { providerCode: code } : {}) };
}

export function parseRealtimeMessage(raw: string): {
  event: string;
  sentence?: RealtimeSentence;
  error?: string;
  failure?: Omit<RealtimeFailure, "taskId">;
} {
  const message = JSON.parse(raw) as {
    header?: { event?: string; error_message?: string; error_code?: string };
    payload?: { output?: { sentence?: Record<string, unknown> } };
  };
  const event = message.header?.event ?? "";
  if (event === "task-failed") {
    return { event, error: message.header?.error_message || "实时转写失败", failure: classifyRealtimeFailure(message.header?.error_code, message.header?.error_message) };
  }
  const sentence = message.payload?.output?.sentence;
  if (event === "result-generated" && sentence && sentence.heartbeat !== true) {
    const text = typeof sentence.text === "string" ? sentence.text.trim() : "";
    if (!text) return { event };
    return {
      event,
      sentence: {
        sentenceId: String(sentence.sentence_id ?? ""),
        text,
        tStartMs: typeof sentence.begin_time === "number" ? sentence.begin_time : 0,
        final: sentence.sentence_end === true,
      },
    };
  }
  return { event };
}

export function defaultSocketConnect(url: string, headers: Record<string, string>): RealtimeSocket {
  const ws = new WebSocket(url, { headers } as never);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onOpen: (fn) => {
      ws.addEventListener("open", fn);
    },
    onMessage: (fn) => {
      ws.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        fn(data);
      });
    },
    onError: (fn) => {
      ws.addEventListener("error", () => fn(new Error("实时转写连接失败")));
    },
    onClose: (fn) => {
      ws.addEventListener("close", fn);
    },
  };
}

export function createRealtimeSession(opts: {
  apiKey: string;
  onSentence: (sentence: RealtimeSentence) => void;
  onReady?: () => void;
  taskId?: string;
  readyTimeoutMs?: number;
  onError?: (message: string, failure: RealtimeFailure) => void;
  connect?: SocketConnect;
}) {
  const vocabulary = hotwordParameters(REALTIME_MODEL, opts.apiKey);
  const connect = opts.connect ?? defaultSocketConnect;
  const taskId = opts.taskId ?? randomUUID();
  const usageAt = Date.now();
  let transmitted = 0, lastMetered = 0;
  function meter(raw?: unknown) {
    const usage = parseUsage(raw);
    if (!transmitted && usage.audioSeconds === undefined) return;
    recordUsage({ id: taskId, at: usageAt, model: REALTIME_MODEL, kind: "realtime-asr", audioSeconds: usage.audioSeconds ?? transmitted / 32000,
      measurement: usage.audioSeconds === undefined ? "local" : "provider", outcome: "uncertain" });
    lastMetered = transmitted;
  }
  const queue: { pcm: Buffer; offsetMs: number }[] = [];
  let socket: RealtimeSocket | null = null;
  let started = false;
  let closed = false;
  let audioOriginMs: number | null = null;
  let unnamedSentence = 0;
  const readyTimer = setTimeout(() => fail("实时转写连接超时", { category: "ready-timeout", retryable: true }), opts.readyTimeoutMs ?? 15_000);
  readyTimer.unref();

  function sendAudio(pcm: Buffer, offsetMs: number): void {
    if (!socket || closed) return;
    audioOriginMs ??= offsetMs;
    try { socket.send(pcm); transmitted += pcm.length; if (transmitted - lastMetered >= 32000 * 30) meter(); } catch { fail("实时转写已断开"); }
  }

  function fail(message: string, failure: Omit<RealtimeFailure, "taskId"> = { category: "transport", retryable: true }): void {
    if (closed) return;
    meter();
    closed = true;
    clearTimeout(readyTimer);
    queue.length = 0;
    try { socket?.close(); } catch { /* already disconnected */ }
    socket = null;
    opts.onError?.(message, { ...failure, taskId });
  }

  function flush(): void {
    if (!socket || !started) return;
    for (const chunk of queue) sendAudio(chunk.pcm, chunk.offsetMs);
    queue.length = 0;
  }

  function sendJson(body: unknown): void {
    try { socket?.send(JSON.stringify(body)); } catch { fail("实时转写已断开"); }
  }

  try { socket = connect(REALTIME_URL, { Authorization: `Bearer ${opts.apiKey}` }); }
  catch { fail("实时转写连接失败"); }
  socket?.onOpen(() => {
    if (closed) return;
    sendJson({
      header: { action: "run-task", task_id: taskId, streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: REALTIME_MODEL,
        parameters: { format: "pcm", sample_rate: 16000, ...vocabulary, heartbeat: true },
        input: {},
      },
    });
  });
  socket?.onMessage((data) => {
    if (closed) return;
    let parsed: ReturnType<typeof parseRealtimeMessage>;
    try {
      parsed = parseRealtimeMessage(data);
    } catch {
      return;
    }
    if (parsed.event === "task-started") {
      if (started) return;
      clearTimeout(readyTimer);
      started = true;
      flush();
      if (!closed) opts.onReady?.();
      return;
    }
    if (parsed.event === "task-failed") {
      fail(parsed.error ?? "实时转写失败", parsed.failure);
      return;
    }
    if (parsed.event === "task-finished") {
      fail("实时转写任务意外结束", { category: "task-finished", retryable: true });
      return;
    }
    if (parsed.sentence?.final) meter(JSON.parse(data));
    if (parsed.sentence) {
      const sentence = parsed.sentence;
      opts.onSentence({
        ...sentence,
        sentenceId: sentence.sentenceId || `unnamed-${unnamedSentence}`,
        tStartMs: (audioOriginMs ?? 0) + sentence.tStartMs,
      });
      if (!sentence.sentenceId && sentence.final) unnamedSentence += 1;
    }
  });
  socket?.onError((err) => {
    fail(err.message);
  });
  socket?.onClose(() => {
    fail("实时转写已断开");
  });

  return {
    sendPcm(pcm: Buffer, offsetMs = 0): void {
      if (closed || pcm.length === 0) return;
      if (started && socket) {
        sendAudio(pcm, offsetMs);
        return;
      }
      queue.push({ pcm: Buffer.from(pcm), offsetMs });
      if (queue.length > QUEUE_CAP) queue.shift();
    },
    stop(): void {
      if (closed) return;
      meter();
      closed = true;
      clearTimeout(readyTimer);
      if (started) {
        sendJson({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        });
      }
      try { socket?.close(); } catch { /* already disconnected */ }
      socket = null;
      queue.length = 0;
    },
  };
}

export type RealtimeSession = ReturnType<typeof createRealtimeSession>;
