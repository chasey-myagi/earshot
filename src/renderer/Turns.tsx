import { memo, useMemo, useRef, useState } from "react";
import type { TranscriptTurn } from "../shared/types";
import { formatClock } from "./format";
import { TranscriptEditor } from "./TranscriptEditor";

type TurnsProps = {
  turns: TranscriptTurn[];
  sessionId?: string;
  editable?: boolean;
  startedAt?: string | null;
  variant: "library" | "glance";
  onSeek?: (positionMs: number) => void;
  playbackPositionMs?: number;
  onRename?: (speaker: string, anchor: HTMLElement) => void;
};

function nameOf(turn: TranscriptTurn, glance: boolean): string {
  if (glance) return turn.track === "you" ? turn.speaker === "你" ? "你" : "现场" : "对方";
  return turn.speaker || "对方";
}

type TurnRowProps = {
  turn: TranscriptTurn;
  sessionId?: string;
  editable?: boolean;
  glance: boolean;
  active: boolean;
  onSeek?: (positionMs: number) => void;
  onRename?: (speaker: string, anchor: HTMLElement) => void;
};

const TurnRow = memo(function TurnRow({ turn, sessionId, editable, glance, active, onSeek, onRename }: TurnRowProps) {
  const name = nameOf(turn, glance);
  const clickable = !glance && !turn.correction?.speakerOverridden && turn.speaker !== "你" && Boolean(onRename);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const canEdit = !glance && editable && sessionId && turn.correction && !turn.partial;

  return (
    <article data-turn-id={turn.id} data-time-ms={turn.tStartMs}
      className={`turn${active ? " playing-turn" : ""}${turn.partial ? " partial" : ""}${glance ? " glance-turn" : ""}`}>
      {glance ? null : (
        onSeek ? <button type="button" className="t-time seek-time"
          aria-label={`从 ${formatClock(turn.tStartMs / 1000)} 回听`} onClick={() => onSeek(turn.tStartMs)}>
          {formatClock(turn.tStartMs / 1000)}
        </button> : <time className="t-time">{formatClock(turn.tStartMs / 1000)}</time>
      )}
      <div className="t-body">
        <div className="t-head">
          <i className={`t-dot ${turn.track}`} aria-hidden />
          {clickable ? (
            <button
              type="button"
              className={`t-name ${turn.track} click`}
              title="修改这位说话人的整组发言名称"
              onClick={(event) => onRename?.(turn.speaker || name, event.currentTarget)}
            >
              {name}<span className="name-edit-cue" aria-hidden="true">整组改名</span>
            </button>
          ) : (
            <span className={`t-name ${turn.track}`}>{name}</span>
          )}
          {canEdit && <button ref={editButton} type="button" className="turn-edit-button" aria-expanded={editing}
            aria-label={`修改 ${formatClock(turn.tStartMs / 1000)} 这一段`} onClick={() => setEditing(value => !value)}>{turn.correction?.edited ? "已修改 · 编辑" : "修改这一段"}</button>}
        </div>
        <p className="t-text">{turn.text || "\u00a0"}</p>
        {editing && canEdit && <TranscriptEditor key={`${sessionId}:${turn.id}`} sessionId={sessionId} turn={turn}
          onSave={window.earshot.correctTurn} onUndo={window.earshot.undoTurnCorrection} onReset={window.earshot.resetTurnCorrection}
          onClose={() => { setEditing(false); requestAnimationFrame(() => editButton.current?.focus()); }} />}
      </div>
    </article>
  );
});

export const Turns = memo(function Turns({ turns, sessionId, editable, variant, onRename, onSeek, playbackPositionMs }: TurnsProps) {
  const glance = variant === "glance";
  const rows = useMemo(() => (glance ? turns.slice(-8) : turns), [glance, turns]);

  let activeId: string | undefined;
  if (playbackPositionMs !== undefined) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.tStartMs <= playbackPositionMs && (row.tEndMs === undefined || playbackPositionMs <= row.tEndMs)) { activeId = row.id; break; }
    }
  }
  if (rows.length === 0) {
    if (glance) return null;
    return (
      <div className="empty-turns">
        <p>暂无转写文字</p>
      </div>
    );
  }

  return (
    <div className={`turns${glance ? " turns-glance" : ""}`}>
      {rows.map((turn) => (
        <TurnRow key={turn.id} turn={turn} sessionId={sessionId} editable={editable} glance={glance} active={turn.id === activeId} onRename={onRename} onSeek={onSeek} />
      ))}
    </div>
  );
});
