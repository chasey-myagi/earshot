import type { SessionDetail } from "../shared/types";

export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, "0")).join(":");
}

export function transcriptDocument(detail: SessionDetail) {
  const { id, title, startedAt, endedAt, durationSec, status } = detail;
  return {
    schema_version: 1,
    session: { id, title, startedAt, endedAt, durationSec, status },
    turns: detail.turns.filter((turn) => !turn.partial && turn.text.trim()).map((turn) => ({
      id: turn.id,
      track: turn.track,
      speaker: turn.correction?.speakerOverridden ? turn.speaker : turn.track === "you" ? "你" : turn.speaker || "对方",
      tStartMs: turn.tStartMs,
      ...(turn.tEndMs === undefined ? {} : { tEndMs: turn.tEndMs }),
      text: turn.text,
    })),
  };
}

