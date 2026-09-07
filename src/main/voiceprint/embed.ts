import { createRequire } from "node:module";
import { existsSync } from "node:fs";

type SherpaExtractor = {
  dim: number;
  createStream: () => {
    acceptWaveform: (wave: { sampleRate: number; samples: Float32Array }) => void;
  };
  compute: (stream: unknown) => Float32Array | number[];
};

type SherpaOnnx = {
  SpeakerEmbeddingExtractor: new (config: {
    model: string;
    numThreads?: number;
    debug?: boolean;
    provider?: string;
  }) => SherpaExtractor;
};

export const EMBEDDING_DIM = 192;

export function extractEmbedding(opts: {
  samples: Float32Array;
  sampleRate?: number;
  modelPath: string;
}): Float32Array {
  if (!existsSync(opts.modelPath)) throw new Error("voiceprint model missing");
  if (opts.samples.length < 16000) throw new Error("not enough audio");
  const sherpa = loadSherpa();
  const extractor = new sherpa.SpeakerEmbeddingExtractor({
    model: opts.modelPath,
    numThreads: 1,
    debug: false,
    provider: "cpu",
  });
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: opts.sampleRate ?? 16000, samples: opts.samples });
  const raw = extractor.compute(stream);
  const embedding = raw instanceof Float32Array ? raw : new Float32Array(raw);
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`unexpected embedding dim ${embedding.length}`);
  }
  return new Float32Array(embedding);
}

export function loadSherpa(): SherpaOnnx {
  return createRequire(import.meta.url)("sherpa-onnx-node") as SherpaOnnx;
}
