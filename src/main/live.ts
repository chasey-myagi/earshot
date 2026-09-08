import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Track, TranscriptTurn } from "../shared/types";
import type { RealtimeSentence } from "./providers/realtime.ts";
import type { SessionStore } from "./store/sessions.ts";
import { mergeTurns } from "./store/transcript.ts";

export function persistLive(dir: string, turn: TranscriptTurn): void {
  appendFileSync(
    join(dir, "live.jsonl"),
    `${JSON.stringify({
      id: turn.id,
      track: turn.track,
      speaker: turn.speaker,
      tStartMs: turn.tStartMs,
      text: turn.text,
    })}\n`,
  );
}

export function markLiveDegraded(store: SessionStore, sessionId: string, message: string): void {
  console.error("[earshot] realtime", message);
  store.patchJobs(sessionId, { live: "failed" });
}

export function createLiveBuffer() {
  const finals = new Map<string, TranscriptTurn>();
  const partials = new Map<Track, TranscriptTurn>();
  let cached: TranscriptTurn[] | null = null;

  function turns(): TranscriptTurn[] {
    if (cached) return cached;
    const all = [...finals.values(), ...partials.values()];
    cached = mergeTurns(
      all.filter((row) => row.track === "you"),
      all.filter((row) => row.track === "other"),
    );
    return cached;
  }

  function apply(track: Track, sentence: RealtimeSentence, sharedMicrophone = false): TranscriptTurn | null {
    const speaker = track === "you" ? sharedMicrophone ? "现场" : "你" : "对方";
    const id = `live-${track}-${sentence.sentenceId || (sentence.final ? `f${finals.size}` : "cur")}`;
    if (finals.has(id)) return null;
    cached = null;
    const turn: TranscriptTurn = {
      id,
      track,
      speaker,
      tStartMs: sentence.tStartMs,
      text: sentence.text,
      partial: !sentence.final,
    };
    if (!sentence.final) {
      partials.set(track, turn);
      return null;
    }
    partials.delete(track);
    const committed = { ...turn, partial: undefined };
    finals.set(id, committed);
    return committed;
  }

  function reset(): void {
    finals.clear();
    partials.clear();
    cached = null;
  }

  function clearPartials(track?: Track): void { if (track) partials.delete(track); else partials.clear(); cached = null; }
  return { apply, turns, reset, clearPartials };
}

export type LiveBuffer = ReturnType<typeof createLiveBuffer>;
