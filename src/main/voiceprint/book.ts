import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJson } from "../store/json.ts";
import type { PersonEmbeddings } from "./match.ts";
import { VOICEPRINT_MODEL } from "./paths.ts";
import type { VoiceSegment } from "./select.ts";

const MAX_EMBEDDINGS = 3;
export type VoiceSource = { sessionId: string; artifact: string; cluster: string; segments: VoiceSegment[]; audioKey?: string; track?: "you" | "other" };
type Template = { model: string; embedding: string; source?: VoiceSource };
type Person = { id: string; name: string; templates: Template[] };

export function voiceBookPath(rootDir: string): string { return join(rootDir, "people-voice.json"); }

export function hasAnyVoiceprint(rootDir: string): boolean { return readVoiceBook(rootDir).length > 0; }

export function readVoiceBook(rootDir: string): PersonEmbeddings[] {
  try {
    return readPeople(rootDir).map(person => ({ id: person.id, name: person.name,
      embeddings: person.templates.filter(template => template.model === VOICEPRINT_MODEL)
        .map(template => decodeEmbedding(template.embedding)).filter(validEmbedding),
    })).filter(person => person.embeddings.length > 0);
  } catch { return []; }
}

function validEmbedding(embedding: Float32Array): boolean {
  return embedding.length > 0 && embedding.every(Number.isFinite) && embedding.some(value => value !== 0);
}

function legacyId(name: string): string {
  const hash = createHash("sha256").update(`earshot-person:${name}`).digest("hex");
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}

function readPeople(rootDir: string): Person[] {
  const path = voiceBookPath(rootDir);
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw.schema_version === 2 && Array.isArray(raw.people)) {
    if (!raw.people.every((person: Person) => typeof person.id === "string" && typeof person.name === "string" && Array.isArray(person.templates))) throw new Error("声纹记录损坏");
    return raw.people;
  }
  if (!raw.people || typeof raw.people !== "object" || Array.isArray(raw.people)) throw new Error("声纹记录损坏");
  return Object.entries(raw.people).map(([name, rows]) => ({ id: legacyId(name), name,
    templates: (Array.isArray(rows) ? rows : []).filter((row): row is string => typeof row === "string")
      .map(embedding => ({ model: VOICEPRINT_MODEL, embedding })),
  }));
}

export function addVoiceprint(rootDir: string, name: string, embedding: Float32Array, source?: VoiceSource): void {
  const trimmed = name.trim();
  if (!trimmed || !validEmbedding(embedding)) return;
  const people = readPeople(rootDir);
  let person = people.find(row => row.name === trimmed);
  if (!person) { person = { id: randomUUID(), name: trimmed, templates: [] }; people.push(person); }
  if (source) {
    // A user's correction replaces this exact sample, including a formerly wrong name.
    const key = sampleKey(source);
    for (const row of people) row.templates = row.templates.filter(template => (!template.source || sampleKey(template.source) !== key));
  }
  person.templates.push({ model: VOICEPRINT_MODEL, embedding: encodeEmbedding(embedding), ...(source ? { source } : {}) });
  person.templates = person.templates.slice(-MAX_EMBEDDINGS);
  const path = voiceBookPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeJson(path, { schema_version: 2, people });
}

function sampleKey(source: VoiceSource): string {
  return JSON.stringify(source.audioKey
    ? [source.sessionId, source.audioKey, source.track ?? "other", source.segments]
    : [source.sessionId, source.artifact, source.cluster, source.segments]);
}

export function retireWrongSource(rootDir: string, name: string, source: VoiceSource): void {
  const people = readPeople(rootDir);
  let changed = false;
  for (const person of people) {
    if (person.name === name) continue;
    const before = person.templates.length;
    person.templates = person.templates.filter(template => {
      const previous = template.source;
      if (!previous || previous.sessionId !== source.sessionId) return true;
      if (!previous.audioKey || !source.audioKey) return previous.artifact !== source.artifact || previous.cluster !== source.cluster;
      // Artifact numbers change on retries. The corrected audio spans do not.
      const sameAudio = previous.audioKey === source.audioKey && (previous.track ?? "other") === (source.track ?? "other");
      const covered = previous.segments.every(segment => source.segments.some(span => span.startMs <= segment.startMs && span.endMs >= segment.endMs));
      return !(sameAudio && covered);
    });
    changed ||= person.templates.length !== before;
  }
  if (changed) writeJson(voiceBookPath(rootDir), { schema_version: 2, people });
}

export function encodeEmbedding(embedding: Float32Array): string {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength).toString("base64");
}

export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  if (buf.length % 4 !== 0) return new Float32Array();
  const copy = new Uint8Array(buf.length); copy.set(buf);
  return new Float32Array(copy.buffer);
}
