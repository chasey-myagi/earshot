import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "../store/sessions.ts";
import { audioKey } from "../providers/asr-checkpoint.ts";
import { addVoiceprint, retireWrongSource } from "./book.ts";
import { defaultEmbed, type EmbedFn } from "./embed-run.ts";
import { parseSpeakerClusters, type VoiceCluster } from "./select.ts";
import { voiceEvidence } from "./evidence.ts";

export type EnrollmentResult = "remembered" | "insufficient" | "conflicting" | "unavailable" | "stale";

export async function enrollSpeaker(opts: {
  store: SessionStore;
  sessionId: string;
  from: string;
  to: string;
  embed?: EmbedFn;
  isCurrent?: () => boolean;
}): Promise<EnrollmentResult> {
  try {
    return await runEnroll(opts);
  } catch (err) {
    console.error("[earshot] voiceprint enroll unavailable");
    return "unavailable";
  }
}

async function runEnroll(opts: {
  store: SessionStore;
  sessionId: string;
  from: string;
  to: string;
  embed?: EmbedFn;
  isCurrent?: () => boolean;
}): Promise<EnrollmentResult> {
  const embed = opts.embed ?? defaultEmbed;
  const to = opts.to.trim();
  if (!to || to === "你" || opts.isCurrent?.() === false) return "stale";
  const doc = opts.store.readSession(opts.sessionId);
  const speakersName = doc?.jobs.speakers.current;
  if (!speakersName) return "insufficient";
  const dir = opts.store.sessionDir(opts.sessionId);
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(join(dir, speakersName), "utf8"));
  } catch {
    return "unavailable";
  }
  const clusters = parseSpeakerClusters(raw);
  const cluster = opts.isCurrent
    ? clusters.find(cluster => cluster.speaker === opts.from)
    : clusterForRename(clusters, opts.store.readNames(opts.sessionId), opts.from, to);
  if (!cluster) return "insufficient";
  if (opts.store.readNames(opts.sessionId)[cluster.speaker] !== to) return "stale";
  const wavPath = join(dir, cluster.track === "you" ? "mic.wav" : "system.wav");
  if (!existsSync(wavPath)) return "insufficient";
  const source = { sessionId: opts.sessionId, artifact: speakersName, cluster: cluster.speaker,
    segments: cluster.segments, track: cluster.track ?? "other" as const, audioKey: await audioKey(wavPath, true) };
  if (opts.isCurrent?.() === false || opts.store.readNames(opts.sessionId)[cluster.speaker] !== to) return "stale";
  retireWrongSource(opts.store.rootDir, to, source);
  const evidence = await voiceEvidence(wavPath, cluster, clusters, embed, { isCurrent: opts.isCurrent });
  if (evidence.status !== "ready") return evidence.status;
  if (opts.isCurrent?.() === false) return "stale";
  const latest = opts.store.readSession(opts.sessionId);
  if (latest?.jobs.speakers.current !== speakersName || latest?.jobs.refined.current !== doc?.jobs.refined.current) return "stale";
  if (opts.store.readNames(opts.sessionId)[cluster.speaker] !== to) return "stale";
  for (const [index, embedding] of evidence.embeddings.entries()) addVoiceprint(opts.store.rootDir, to, embedding, {
    ...source, segments: [evidence.segments[index]!],
  });
  return "remembered";
}

function clusterForRename(clusters: VoiceCluster[], names: Record<string, string>, from: string, to: string): VoiceCluster | undefined {
  const direct = clusters.find((cluster) => cluster.speaker === from.trim());
  if (direct) return direct;
  // 回找按 names[簇]===to，依赖主进程先 rename 后 enroll 的调用序
  return clusters.find((cluster) => names[cluster.speaker] === to || cluster.speaker === to);
}
