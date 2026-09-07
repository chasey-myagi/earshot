import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Track, TranscriptTurn } from "../../shared/types";

export function clusterName(index: number): string {
  if (!Number.isFinite(index) || index < 0) return "对方";
  let n = Math.floor(index);
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `小 ${label}`;
}

export function speakerFromId(raw: unknown): string {
  if (typeof raw === "number" && Number.isFinite(raw)) return clusterName(raw);
  if (typeof raw === "string") {
    const match = raw.match(/(\d+)/);
    if (match) return clusterName(Number(match[1]));
  }
  return "对方";
}

export function mergeTurns(mic: TranscriptTurn[], system: TranscriptTurn[]): TranscriptTurn[] {
  return [...mic, ...system].sort((a, b) => {
    if (a.tStartMs !== b.tStartMs) return a.tStartMs - b.tStartMs;
    if (a.track === b.track) return 0;
    return a.track === "you" ? -1 : 1;
  });
}

export function applyNames(turns: TranscriptTurn[], names: Record<string, string>): TranscriptTurn[] {
  return turns.map((turn) => {
    const mapped = names[turn.speaker];
    return mapped ? { ...turn, speaker: mapped } : turn;
  });
}

export function readLiveJsonl(path: string): TranscriptTurn[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const turns: TranscriptTurn[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Partial<TranscriptTurn>;
      if (typeof row.id !== "string" || typeof row.text !== "string") continue;
      const track: Track = row.track === "you" ? "you" : "other";
      turns.push({
        id: row.id,
        track,
        speaker: typeof row.speaker === "string" ? row.speaker : track === "you" ? "你" : "对方",
        tStartMs: typeof row.tStartMs === "number" ? row.tStartMs : 0,
        text: row.text,
      });
    } catch {
      // skip a corrupt line; the rest of the file still stands
    }
  }
  return mergeTurns(turns.filter(turn => turn.track === "you"), turns.filter(turn => turn.track === "other"));
}

export function readRefinedFile(path: string): TranscriptTurn[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { turns?: unknown };
    if (!Array.isArray(raw.turns)) return [];
    return raw.turns.filter(isTurn);
  } catch {
    return [];
  }
}

function isTurn(value: unknown): value is TranscriptTurn {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<TranscriptTurn>;
  return (
    typeof row.id === "string" &&
    (row.track === "you" || row.track === "other") &&
    typeof row.speaker === "string" &&
    typeof row.tStartMs === "number" &&
    typeof row.text === "string"
  );
}

export function sessionTranscript(dir: string, currentRefined: string | null, names: Record<string, string>): TranscriptTurn[] {
  const refinedPath = currentRefined ? join(dir, currentRefined) : "";
  const turns = refinedPath && existsSync(refinedPath) ? readRefinedFile(refinedPath) : readLiveJsonl(join(dir, "live.jsonl"));
  return applyNames(turns, names);
}
