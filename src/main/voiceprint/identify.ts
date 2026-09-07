import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "../store/sessions.ts";
import { hasAnyVoiceprint, readVoiceBook } from "./book.ts";
import { defaultEmbed, type EmbedFn } from "./embed-run.ts";
import { assignClusters } from "./match.ts";
import { parseSpeakerClusters, selectClusterPcm } from "./select.ts";
import { s16leToFloat32 } from "./wav.ts";

export type { EmbedFn };

export async function identifySession(opts: {
  store: SessionStore;
  sessionId: string;
  embed?: EmbedFn;
}): Promise<void> {
  try {
    await runIdentify(opts);
  } catch (err) {
    console.error("[earshot] voiceprint identify failed", err);
  }
}

async function runIdentify(opts: { store: SessionStore; sessionId: string; embed?: EmbedFn }): Promise<void> {
  if (!hasAnyVoiceprint(opts.store.rootDir)) return;
  const embed = opts.embed ?? defaultEmbed;
  const doc = opts.store.readSession(opts.sessionId);
  const speakersName = doc?.jobs.speakers.current;
  if (!speakersName) return;
  const dir = opts.store.sessionDir(opts.sessionId);
  const wavPath = join(dir, "system.wav");
  if (!existsSync(wavPath)) return;
  const clusters = parseSpeakerClusters(readJson(join(dir, speakersName)));
  if (clusters.length === 0) return;
  const names = opts.store.readNames(opts.sessionId);
  const pending = clusters.filter((cluster) => !names[cluster.speaker] && cluster.speaker !== "你");
  if (pending.length === 0) return;

  const embeddings: { id: string; embedding: Float32Array }[] = [];
  for (const cluster of pending) {
    const pcm = selectClusterPcm(wavPath, cluster);
    if (pcm.length < 16000 * 2) continue;
    const embedding = await embed(s16leToFloat32(pcm));
    if (embedding && embedding.length) embeddings.push({ id: cluster.speaker, embedding });
  }
  const hits = assignClusters({ clusters: embeddings, people: readVoiceBook(opts.store.rootDir) });
  if (hits.length === 0) return;
  const autoNames: Record<string, string> = {};
  for (const hit of hits) {
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
