import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findVoiceprintModel } from "./paths.ts";

type UtilityProcessMod = {
  fork: (modulePath: string) => UtilityChild;
};

type UtilityChild = {
  pid?: number;
  postMessage: (msg: unknown) => void;
  kill: () => void;
  on: (event: "message" | "spawn" | "exit", listener: (...args: never[]) => void) => void;
};

export type EmbedFn = (pcm: Float32Array, signal?: AbortSignal) => Promise<Float32Array | null>;
let embeddingQueue: Promise<unknown> = Promise.resolve();

export async function defaultEmbed(samples: Float32Array, signal?: AbortSignal): Promise<Float32Array | null> {
  const modelPath = findVoiceprintModel();
  if (!modelPath) return null;
  try {
    const work = embeddingQueue.then(() => embedViaChild(samples, modelPath, { signal }));
    embeddingQueue = work.catch(() => undefined);
    return await work;
  } catch (err) {
    console.error("[earshot] voiceprint embed failed", err);
    return null;
  }
}

export async function embedViaChild(samples: Float32Array, modelPath: string, opts: {
  signal?: AbortSignal; fork?: UtilityProcessMod["fork"]; workerPath?: string;
} = {}): Promise<Float32Array> {
  opts.signal?.throwIfAborted();
  const workerPath = opts.workerPath ?? voiceprintWorkerPath();
  const fork = opts.fork ?? await loadUtilityFork();
  opts.signal?.throwIfAborted();
  if (!fork) {
    const { extractEmbedding } = await import("./embed.ts");
    return extractEmbedding({ samples, sampleRate: 16000, modelPath });
  }
  if (!existsSync(workerPath)) throw new Error("voiceprint worker missing");
  return new Promise((resolve, reject) => {
    const child = fork(workerPath);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("voiceprint worker timeout")), 60_000);
    const finish = (err: Error | null, embedding?: Float32Array) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", aborted);
      try {
        child.kill();
      } catch {
        // already exited
      }
      if (err) reject(err);
      else resolve(embedding ?? new Float32Array());
    };
    const aborted = () => finish(new Error("voiceprint canceled"));
    opts.signal?.addEventListener("abort", aborted, { once: true });
    child.on("exit", (() => finish(new Error("voiceprint worker exited"))) as (...args: never[]) => void);
    child.on("message", ((msg: { ok?: boolean; embedding?: number[]; error?: string }) => {
      if (!msg?.ok || !Array.isArray(msg.embedding)) {
        finish(new Error(msg?.error || "voiceprint worker failed"));
        return;
      }
      finish(null, Float32Array.from(msg.embedding));
    }) as (...args: never[]) => void);
    const send = () => {
      try { child.postMessage({
        samples: Array.from(samples),
        sampleRate: 16000,
        modelPath,
      }); } catch { finish(new Error("voiceprint worker send failed")); }
    };
    if (typeof child.pid === "number") send();
    else child.on("spawn", send as (...args: never[]) => void);
  });
}

function voiceprintWorkerPath(): string {
  const here = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
  return join(here, "voiceprint-worker.js");
}

async function loadUtilityFork(): Promise<UtilityProcessMod["fork"] | null> {
  try {
    const electron = (await import("electron")) as { utilityProcess?: UtilityProcessMod };
    return electron.utilityProcess?.fork ?? null;
  } catch {
    return null;
  }
}
