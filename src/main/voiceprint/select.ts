import { readWavRange } from "./wav.ts";

export const MIN_CLUSTER_MS = 6000;
export const MAX_CLUSTER_MS = 10000;

export type VoiceSegment = { startMs: number; endMs: number };
export type VoiceCluster = { speaker: string; segments: VoiceSegment[] };

export function selectClusterPcm(wavPath: string, cluster: VoiceCluster): Buffer {
  const picked = pickSegments(cluster.segments);
  return Buffer.concat(picked.map((seg) => readWavRange(wavPath, seg.startMs, seg.endMs)));
}

export function parseSpeakerClusters(raw: unknown): VoiceCluster[] {
  if (!raw || typeof raw !== "object") return [];
  const clusters = (raw as { clusters?: unknown }).clusters;
  if (!Array.isArray(clusters)) return [];
  const out: VoiceCluster[] = [];
  for (const row of clusters) {
    if (!row || typeof row !== "object") continue;
    const item = row as { speaker?: unknown; segments?: unknown };
    if (typeof item.speaker !== "string" || !item.speaker.trim()) continue;
    if (!Array.isArray(item.segments)) continue;
    const segments: VoiceSegment[] = [];
    for (const seg of item.segments) {
      if (!seg || typeof seg !== "object") continue;
      const span = seg as { startMs?: unknown; endMs?: unknown };
      if (typeof span.startMs !== "number" || typeof span.endMs !== "number") continue;
      if (span.endMs <= span.startMs) continue;
      segments.push({ startMs: span.startMs, endMs: span.endMs });
    }
    if (segments.length) out.push({ speaker: item.speaker, segments });
  }
  return out;
}

export function pickSegments(segments: VoiceSegment[]): VoiceSegment[] {
  const valid = segments.filter((seg) => seg.endMs > seg.startMs);
  const ranked = [...valid].sort((a, b) => duration(b) - duration(a) || a.startMs - b.startMs);
  const chosen: VoiceSegment[] = [];
  let total = 0;
  for (const seg of ranked) {
    if (total >= MIN_CLUSTER_MS) break;
    const d = duration(seg);
    if (total + d > MAX_CLUSTER_MS) {
      chosen.push({ startMs: seg.startMs, endMs: seg.startMs + (MAX_CLUSTER_MS - total) });
      break;
    }
    chosen.push(seg);
    total += d;
  }
  return chosen.sort((a, b) => a.startMs - b.startMs);
}

export function clustersFromTurns(
  turns: Array<{ speaker: string; tStartMs: number; tEndMs?: number; track?: string }>,
  durationMs: number,
): VoiceCluster[] {
  const rows = turns.filter((turn) => turn.track !== "you" && turn.speaker !== "你");
  const sorted = [...rows].sort((a, b) => a.tStartMs - b.tStartMs);
  const bySpeaker = new Map<string, VoiceSegment[]>();
  for (let i = 0; i < sorted.length; i += 1) {
    const startMs = sorted[i]?.tStartMs ?? 0;
    const nextStart = i + 1 < sorted.length ? (sorted[i + 1]?.tStartMs ?? durationMs) : durationMs;
    const markedEnd = sorted[i]?.tEndMs;
    const endMs = typeof markedEnd === "number" && markedEnd > startMs ? markedEnd : nextStart;
    if (endMs <= startMs) continue;
    const speaker = sorted[i]?.speaker ?? "";
    if (!speaker) continue;
    const list = bySpeaker.get(speaker) ?? [];
    list.push({ startMs, endMs });
    bySpeaker.set(speaker, list);
  }
  return [...bySpeaker.entries()].map(([speaker, segments]) => ({ speaker, segments }));
}

function duration(seg: VoiceSegment): number {
  return seg.endMs - seg.startMs;
}
