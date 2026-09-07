import { randomUUID } from "node:crypto";
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

export function parseRealtimeMessage(raw: string): {
  event: string;
  sentence?: RealtimeSentence;
  error?: string;
} {
  const message = JSON.parse(raw) as {
    header?: { event?: string; error_message?: string };
    payload?: { output?: { sentence?: Record<string, unknown> } };
  };
  const event = message.header?.event ?? "";
  if (event === "task-failed") {
    return { event, error: message.header?.error_message || "实时转写失败" };
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
  readyTimeoutMs?: number;
  onError?: (message: string) => void;
  connect?: SocketConnect;
}) {
  const connect = opts.connect ?? defaultSocketConnect;
  const taskId = randomUUID();
  const queue: { pcm: Buffer; offsetMs: number }[] = [];
  let socket: RealtimeSocket | null = null;
  let started = false;
  let closed = false;
  let audioOriginMs: number | null = null;
  let unnamedSentence = 0;
  const readyTimer = setTimeout(() => fail("实时转写连接超时"), opts.readyTimeoutMs ?? 15_000);
  readyTimer.unref();

  function sendAudio(pcm: Buffer, offsetMs: number): void {
    if (!socket || closed) return;
    audioOriginMs ??= offsetMs;
    try { socket.send(pcm); } catch { fail("实时转写已断开"); }
  }

  function fail(message: string): void {
    if (closed) return;
    closed = true;
    clearTimeout(readyTimer);
    queue.length = 0;
    try { socket?.close(); } catch { /* already disconnected */ }
    socket = null;
    opts.onError?.(message);
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
  catch (error) { clearTimeout(readyTimer); throw error; }
  socket.onOpen(() => {
    if (closed) return;
    sendJson({
      header: { action: "run-task", task_id: taskId, streaming: "duplex" },
      payload: {
        task_group: "audio",
        task: "asr",
        function: "recognition",
        model: REALTIME_MODEL,
        parameters: { format: "pcm", sample_rate: 16000 },
        input: {},
      },
    });
  });
  socket.onMessage((data) => {
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
      fail(parsed.error ?? "实时转写失败");
      return;
    }
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
  socket.onError((err) => {
    fail(err.message);
  });
  socket.onClose(() => {
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
