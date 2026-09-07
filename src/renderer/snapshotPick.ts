import type { AppSnapshot, RecordingLive, TranscriptTurn } from "../shared/types";

function partialFingerprint(turns: TranscriptTurn[]): string {
  return turns
    .filter((turn) => turn.partial)
    .map((turn) => `${turn.id}::${turn.text}`)
    .join("||");
}

function tailTurn(turns: TranscriptTurn[]): TranscriptTurn | undefined {
  return turns[turns.length - 1];
}

/** Glance 只需比较会驱动 UI 的 recording 字段，避免整棵 snap 树重渲 */
export function glanceRecordingEqual(a: RecordingLive | null, b: RecordingLive | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.connection !== b.connection || a.phase !== b.phase || a.storageWarning !== b.storageWarning) return false;
  if (a.sessionId !== b.sessionId || a.elapsedSec !== b.elapsedSec || a.glanceVisible !== b.glanceVisible) {
    return false;
  }
  if (a.turns.length !== b.turns.length) return false;
  if (partialFingerprint(a.turns) !== partialFingerprint(b.turns)) return false;

  const lastA = tailTurn(a.turns);
  const lastB = tailTurn(b.turns);
  if (!lastA && !lastB) return true;
  if (!lastA || !lastB) return false;

  return (
    lastA.id === lastB.id &&
    lastA.text === lastB.text &&
    Boolean(lastA.partial) === Boolean(lastB.partial) &&
    lastA.track === lastB.track
  );
}

export function pickGlanceSnap(snap: AppSnapshot): Pick<AppSnapshot, "recording"> {
  return { recording: snap.recording };
}

function shareTurns(previous: TranscriptTurn[] | undefined, next: TranscriptTurn[]): TranscriptTurn[] {
  if (!previous) return next;
  const byId = new Map(previous.map(row => [row.id, row]));
  const shared = next.map(row => {
    const old = byId.get(row.id);
    return old && old.track === row.track && old.speaker === row.speaker && old.text === row.text &&
      old.tStartMs === row.tStartMs && old.tEndMs === row.tEndMs && old.partial === row.partial ? old : row;
  });
  return shared.length === previous.length && shared.every((row, i) => row === previous[i]) ? previous : shared;
}

/** Electron clones IPC results. Preserve unchanged row objects for React.memo. */
export function shareSnapshotTurns(previous: AppSnapshot | null, next: AppSnapshot): AppSnapshot {
  const recording = next.recording ? { ...next.recording, turns: shareTurns(
    previous?.recording?.sessionId === next.recording.sessionId ? previous.recording.turns : undefined,
    next.recording.turns,
  ) } : null;
  const selected = next.selected ? { ...next.selected, turns:
    next.selected.id === recording?.sessionId ? recording.turns : shareTurns(
      previous?.selected?.id === next.selected.id ? previous.selected.turns : undefined, next.selected.turns,
    ),
  } : null;
  return { ...next, recording, selected };
}
