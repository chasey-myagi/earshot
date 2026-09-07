import { extractEmbedding } from "./embed.ts";

type ParentPort = {
  postMessage: (msg: unknown) => void;
  on: (event: "message", listener: (event: { data: unknown }) => void) => void;
};

type Req = { samples?: number[]; sampleRate?: number; modelPath?: string };

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;

function send(msg: unknown): void {
  parentPort?.postMessage(msg);
}

function handle(raw: unknown): void {
  const req = raw as Req;
  try {
    if (!req?.modelPath || !Array.isArray(req.samples)) throw new Error("invalid embed request");
    const embedding = extractEmbedding({
      samples: Float32Array.from(req.samples),
      sampleRate: req.sampleRate ?? 16000,
      modelPath: req.modelPath,
    });
    send({ ok: true, embedding: Array.from(embedding) });
  } catch (err) {
    send({ ok: false, error: err instanceof Error ? err.message : "embed failed" });
  }
}

parentPort?.on("message", (event) => {
  handle(event.data);
});
