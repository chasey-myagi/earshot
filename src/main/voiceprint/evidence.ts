import type { EmbedFn } from "./embed-run.ts";
import { cosine, MATCH_THRESHOLD } from "./match.ts";
import { selectVoiceSamples, type VoiceCluster, type VoiceSegment } from "./select.ts";
import { s16leToFloat32 } from "./wav.ts";

export type VoiceEvidence = { status: "ready"; embeddings: Float32Array[]; segments: VoiceSegment[] }
  | { status: "insufficient" | "conflicting" | "unavailable" };

export async function voiceEvidence(wav: string, cluster: VoiceCluster, clusters: VoiceCluster[], embed: EmbedFn, opts: {
  signal?: AbortSignal; isCurrent?: () => boolean;
} = {}): Promise<VoiceEvidence> {
  const samples = selectVoiceSamples(wav, cluster, clusters);
  if (samples.length < 2 || samples.reduce((total, sample) => total + sample.pcm.length, 0) < 6 * 32000) return { status: "insufficient" };
  const embeddings: Float32Array[] = [];
  for (const sample of samples) {
    opts.signal?.throwIfAborted();
    if (opts.isCurrent?.() === false) return { status: "unavailable" };
    const embedding = await embed(s16leToFloat32(sample.pcm), opts.signal);
    opts.signal?.throwIfAborted();
    if (!embedding?.length || !embedding.every(Number.isFinite) || cosine(embedding, embedding) < 0.99) return { status: "unavailable" };
    if (embeddings.some(previous => cosine(previous, embedding) < MATCH_THRESHOLD)) return { status: "conflicting" };
    embeddings.push(embedding);
  }
  return { status: "ready", embeddings, segments: samples.map(sample => sample.segment) };
}
