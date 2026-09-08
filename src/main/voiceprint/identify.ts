import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "../store/sessions.ts";
import { hasAnyVoiceprint, readVoiceBook } from "./book.ts";
import { defaultEmbed, type EmbedFn } from "./embed-run.ts";
import { assignClusters, type ClusterEmbedding } from "./match.ts";
import { parseSpeakerClusters } from "./select.ts";
import { voiceEvidence } from "./evidence.ts";

export type { EmbedFn };

export async function identifySession(opts: {
  store: SessionStore;
  sessionId: string;
  embed?: EmbedFn;
  signal?: AbortSignal;
}): Promise<void> {
  try {
    await runIdentify(opts);
  } catch (err) {
    console.error("[earshot] voiceprint identify failed", err);
  }
}

async function runIdentify(opts: { store: SessionStore; sessionId: string; embed?: EmbedFn; signal?: AbortSignal }): Promise<void> {
  if (!hasAnyVoiceprint(opts.store.rootDir)) return;
  const embed = opts.embed ?? defaultEmbed;
  const doc = opts.store.readSession(opts.sessionId);
  const speakersName = doc?.jobs.speakers.current;
  if (!speakersName) return;
  const dir = opts.store.sessionDir(opts.sessionId);
  const clusters = parseSpeakerClusters(readJson(join(dir, speakersName)));
  if (clusters.length === 0) return;
  const names = opts.store.readNames(opts.sessionId);
  const pending = clusters.filter((cluster) => !names[cluster.speaker] && cluster.speaker !== "你");
  if (pending.length === 0) return;

  const embeddings: ClusterEmbedding[] = [];
  for (const cluster of pending) {
    if (opts.signal?.aborted) return;
    const wavPath = join(dir, cluster.track === "you" ? "mic.wav" : "system.wav");
    if (!existsSync(wavPath)) continue;
    const evidence = await voiceEvidence(wavPath, cluster, clusters, embed, { signal: opts.signal });
    if (evidence.status === "ready") embeddings.push({ id: cluster.speaker,
      embedding: evidence.embeddings[0]!, samples: evidence.embeddings });
  }
  const hits = assignClusters({ clusters: embeddings, people: readVoiceBook(opts.store.rootDir) });
  if (hits.length === 0) return;
  const latest = opts.store.readSession(opts.sessionId);
  if (opts.signal?.aborted || !latest || latest.jobs.speakers.current !== speakersName || latest.jobs.refined.current !== doc?.jobs.refined.current) return;
  const currentNames = opts.store.readNames(opts.sessionId);
  const autoNames: Record<string, string> = {};
  for (const hit of hits) {
    if (currentNames[hit.cluster]) continue;
    const result = opts.store.renameSpeaker({ sessionId: opts.sessionId, from: hit.cluster, to: hit.name });
    if (!result.ok) continue;
    autoNames[hit.cluster] = hit.name;
  }
  if (Object.keys(autoNames).length === 0) return;
  writeFileSync(join(dir, "auto-names.json"), `${JSON.stringify(autoNames, null, 2)}\n`);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
