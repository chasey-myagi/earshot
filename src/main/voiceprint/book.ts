import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PersonEmbeddings } from "./match.ts";

const MAX_EMBEDDINGS = 3;

export function voiceBookPath(rootDir: string): string {
  return join(rootDir, "people-voice.json");
}

export function hasAnyVoiceprint(rootDir: string): boolean {
  return readVoiceBook(rootDir).some((row) => row.embeddings.length > 0);
}

export function readVoiceBook(rootDir: string): PersonEmbeddings[] {
  const path = voiceBookPath(rootDir);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { people?: unknown };
    if (!raw.people || typeof raw.people !== "object" || Array.isArray(raw.people)) return [];
    const out: PersonEmbeddings[] = [];
    for (const [name, rows] of Object.entries(raw.people as Record<string, unknown>)) {
      if (!name.trim() || !Array.isArray(rows)) continue;
      const embeddings = rows.filter((row): row is string => typeof row === "string").map(decodeEmbedding);
      if (embeddings.length) out.push({ name, embeddings });
    }
    return out;
  } catch {
    return [];
  }
}

export function addVoiceprint(rootDir: string, name: string, embedding: Float32Array): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const people: Record<string, string[]> = {};
  for (const row of readVoiceBook(rootDir)) {
    people[row.name] = row.embeddings.map(encodeEmbedding);
  }
  const list = people[trimmed] ?? [];
  list.push(encodeEmbedding(embedding));
  while (list.length > MAX_EMBEDDINGS) list.shift();
  people[trimmed] = list;
  const path = voiceBookPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ schema_version: 1, people }, null, 2)}\n`, { mode: 0o600 });
}

export function encodeEmbedding(embedding: Float32Array): string {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength).toString("base64");
}

export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  const copy = Buffer.allocUnsafe(buf.length);
  buf.copy(copy);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}
