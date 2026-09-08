import { readWavRange, wavDurationMs } from "./wav.ts";

export const MIN_CLUSTER_MS = 6000;
export const MAX_CLUSTER_MS = 10000;

export type VoiceSegment = { startMs: number; endMs: number };
export type VoiceCluster = { speaker: string; segments: VoiceSegment[]; track?: "you" | "other" };

export type VoiceSample = { segment: VoiceSegment; pcm: Buffer };

/** Basic signal screening, not a claim that cloud sentence boundaries are pure speech. */
export function selectVoiceSamples(wavPath: string, cluster: VoiceCluster, all: VoiceCluster[]): VoiceSample[] {
  const durationMs = wavDurationMs(wavPath);
  const valid = (seg: VoiceSegment) => Number.isFinite(seg.startMs) && Number.isFinite(seg.endMs) && seg.endMs > seg.startMs;
  const spans: VoiceSegment[] = [];
  for (const row of cluster.segments.filter(valid).sort((a, b) => a.startMs - b.startMs)) {
    const span = { startMs: Math.max(0, row.startMs), endMs: Math.min(durationMs, row.endMs) };
    const last = spans.at(-1);
    if (last && span.startMs <= last.endMs) last.endMs = Math.max(last.endMs, span.endMs);
    else if (span.endMs > span.startMs) spans.push(span);
  }
  let clean = spans;
  for (const overlap of all.filter(other => other.speaker !== cluster.speaker && (other.track ?? "other") === (cluster.track ?? "other")).flatMap(other => other.segments).filter(valid)) {
    clean = clean.flatMap(span => {
      if (overlap.endMs <= span.startMs || overlap.startMs >= span.endMs) return [span];
      return [{ startMs: span.startMs, endMs: Math.min(span.endMs, overlap.startMs) },
        { startMs: Math.max(span.startMs, overlap.endMs), endMs: span.endMs }].filter(valid);
    });
  }
  const candidates: VoiceSegment[] = [];
  for (const span of clean) {
    for (let startMs = span.startMs; startMs + 2000 <= span.endMs; startMs += 4000) {
      candidates.push({ startMs, endMs: Math.min(startMs + 4000, span.endMs) });
    }
  }
  // Sample across the whole meeting; bound PCM reads and inference work.
  const indices = [...new Set(Array.from({ length: Math.min(12, candidates.length) }, (_, i) =>
    Math.round(i * (candidates.length - 1) / Math.max(1, Math.min(12, candidates.length) - 1))))];
  const out: VoiceSample[] = [];
  for (const index of indices) {
    const segment = candidates[index]!;
    const pcm = readWavRange(wavPath, segment.startMs, segment.endMs);
    if (audible(pcm)) out.push({ segment, pcm });
  }
  if (out.length <= 3) return out;
  return [out[0]!, out[Math.floor((out.length - 1) / 2)]!, out.at(-1)!];
}

// Activity is relative to this candidate's own level: lowering recording gain
// must not turn the same waveform/SNR into "silence". Eight s16 units is only a
// quantization floor (~ -72 dBFS), not a microphone loudness requirement.
const QUANTIZATION_RMS = 8;
const RELATIVE_ACTIVITY = 0.1; // -20 dB from the 90th-percentile frame RMS.

function audible(pcm: Buffer): boolean {
  if (pcm.length < 2 * 16000 * 2) return false;
  const rms: number[] = [];
  let clipped = 0;
  for (let offset = 0; offset + 640 <= pcm.length; offset += 640) {
    let sum = 0, energy = 0;
    for (let byte = offset; byte < offset + 640; byte += 2) {
      const value = pcm.readInt16LE(byte);
      sum += value;
      energy += value * value;
      if (Math.abs(value) >= 32700) clipped++;
    }
    // Remove DC only for screening; the returned original PCM is never altered.
    rms.push(Math.sqrt(Math.max(0, energy / 320 - (sum / 320) ** 2)));
  }
  if (!rms.length || clipped / (pcm.length / 2) >= 0.02) return false;
  const ranked = [...rms].sort((a, b) => a - b);
  const reference = ranked[Math.floor((ranked.length - 1) * 0.9)]!;
  if (reference < QUANTIZATION_RMS) return false;
  const floor = Math.max(QUANTIZATION_RMS, reference * RELATIVE_ACTIVITY);
  if (rms.filter(value => value >= floor).length / rms.length < 0.6) return false;

  // A conservative noise veto, not a VAD or a harmonicity requirement for all
  // speech: only nearly stationary energy (<3 dB p10-to-p90) triggers it.
  // Unvoiced/consonant-rich speech with changing energy bypasses this check.
  const low = ranked[Math.floor((ranked.length - 1) * 0.1)]!;
  if (reference <= low * Math.SQRT2 && !hasPeriodicRegion(pcm)) return false;
  return true;
}

function hasPeriodicRegion(pcm: Buffer): boolean {
  const samples = pcm.length / 2;
  // Inspect eight bounded 40 ms windows. Normalized autocorrelation is gain
  // invariant; a stationary noise floor with no repeated structure stays out.
  // Lags cover about 60-500 Hz. This does not certify a person or pure speech;
  // overlap removal and independent embedding agreement still apply later.
  for (let probe = 0; probe < 8; probe++) {
    const start = Math.floor(probe * (samples - 640) / 7);
    const window = new Float64Array(640);
    let mean = 0;
    for (let i = 0; i < window.length; i++) { window[i] = pcm.readInt16LE((start + i) * 2); mean += window[i]!; }
    mean /= window.length;
    for (let i = 0; i < window.length; i++) window[i] = window[i]! - mean;
    for (let lag = 32; lag <= 268; lag += 4) {
      let cross = 0, left = 0, right = 0;
      for (let i = lag; i < window.length; i += 2) {
        const a = window[i]!, b = window[i - lag]!;
        cross += a * b; left += a * a; right += b * b;
      }
      // Half of the energy repeating at a pitch-scale lag is enough to avoid
      // this noise-only veto. No matching/identity threshold is changed.
      if (left > 0 && right > 0 && cross / Math.sqrt(left * right) >= 0.5) return true;
    }
  }
  return false;
}

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
    const item = row as { speaker?: unknown; segments?: unknown; track?: unknown };
    if (typeof item.speaker !== "string" || !item.speaker.trim()) continue;
    if (!Array.isArray(item.segments)) continue;
    const segments: VoiceSegment[] = [];
    for (const seg of item.segments) {
      if (!seg || typeof seg !== "object") continue;
      const span = seg as { startMs?: unknown; endMs?: unknown };
      if (typeof span.startMs !== "number" || typeof span.endMs !== "number") continue;
      if (!Number.isFinite(span.startMs) || !Number.isFinite(span.endMs) || span.endMs <= span.startMs) continue;
      segments.push({ startMs: span.startMs, endMs: span.endMs });
    }
    if (segments.length) out.push({ speaker: item.speaker, segments, ...(item.track === "you" ? { track: "you" as const } : {}) });
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
  track: "you" | "other" = "other",
): VoiceCluster[] {
  const rows = turns.filter((turn) => (turn.track ?? "other") === track && turn.speaker !== "你");
  const bySpeaker = new Map<string, VoiceSegment[]>();
  for (const row of rows) {
    // Missing end times still yield readable text, but never invented voice samples.
    if (!Number.isFinite(row.tStartMs) || typeof row.tEndMs !== "number" || !Number.isFinite(row.tEndMs)) continue;
    const startMs = Math.max(0, row.tStartMs);
    const endMs = Math.min(durationMs, row.tEndMs);
    if (endMs <= startMs || !row.speaker) continue;
    const list = bySpeaker.get(row.speaker) ?? [];
    list.push({ startMs, endMs });
    bySpeaker.set(row.speaker, list);
  }
  return [...bySpeaker.entries()].map(([speaker, segments]) => ({ speaker, segments, ...(track === "you" ? { track } : {}) }));
}

function duration(seg: VoiceSegment): number {
  return seg.endMs - seg.startMs;
}
