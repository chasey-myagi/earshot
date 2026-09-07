import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "../store/sessions.ts";
import { addVoiceprint } from "./book.ts";
import { defaultEmbed, type EmbedFn } from "./embed-run.ts";
import { parseSpeakerClusters, selectClusterPcm, type VoiceCluster } from "./select.ts";
import { s16leToFloat32 } from "./wav.ts";

export async function enrollSpeaker(opts: {
  store: SessionStore;
  sessionId: string;
  from: string;
  to: string;
  embed?: EmbedFn;
  isCurrent?: () => boolean;
}): Promise<void> {
  try {
    await runEnroll(opts);
  } catch (err) {
    console.error("[earshot] voiceprint enroll failed", err);
  }
}

async function runEnroll(opts: {
  store: SessionStore;
  sessionId: string;
  from: string;
  to: string;
  embed?: EmbedFn;
  isCurrent?: () => boolean;
}): Promise<void> {
  const embed = opts.embed ?? defaultEmbed;
  const to = opts.to.trim();
  if (!to || to === "你" || opts.isCurrent?.() === false) return;
  const doc = opts.store.readSession(opts.sessionId);
  const speakersName = doc?.jobs.speakers.current;
  if (!speakersName) return;
  const dir = opts.store.sessionDir(opts.sessionId);
  const wavPath = join(dir, "system.wav");
  if (!existsSync(wavPath)) return;
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(join(dir, speakersName), "utf8"));
  } catch {
    return;
  }
  const clusters = parseSpeakerClusters(raw);
  const cluster = opts.isCurrent
    ? clusters.find(cluster => cluster.speaker === opts.from)
    : clusterForRename(clusters, opts.store.readNames(opts.sessionId), opts.from, to);
  if (!cluster) return;
  const pcm = selectClusterPcm(wavPath, cluster);
  if (pcm.length < 16000 * 2) return;
  const embedding = await embed(s16leToFloat32(pcm));
  if (!embedding || embedding.length === 0) return;
  if (opts.isCurrent?.() === false) return;
  const latest = opts.store.readSession(opts.sessionId);
  if (latest?.jobs.speakers.current !== speakersName || latest?.jobs.refined.current !== doc?.jobs.refined.current) return;
  if (opts.store.readNames(opts.sessionId)[cluster.speaker] !== to) return;
  addVoiceprint(opts.store.rootDir, to, embedding);
}

function clusterForRename(clusters: VoiceCluster[], names: Record<string, string>, from: string, to: string): VoiceCluster | undefined {
  const direct = clusters.find((cluster) => cluster.speaker === from.trim());
  if (direct) return direct;
  // 回找按 names[簇]===to，依赖主进程先 rename 后 enroll 的调用序
  return clusters.find((cluster) => names[cluster.speaker] === to || cluster.speaker === to);
}
