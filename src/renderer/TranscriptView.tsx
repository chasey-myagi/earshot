import { useLayoutEffect, useRef, useState } from "react";
import type { CapturePhase, RealtimeStatus, SessionDetail } from "../shared/types";
import { captureScrollAnchor, restoreScrollTop, type ScrollAnchor, type ScrollRow } from "./scroll";
import { Turns } from "./Turns";
import { Bookmarks } from "./Bookmarks";

export type ReadingPositions = Map<string, ScrollAnchor>;

export function TranscriptView({ detail, positions, connection, capturePhase, onSeek, playbackPositionMs, onRename, editable, bookmarkPositionMs, focusTurn }: {
  detail: SessionDetail;
  editable?: boolean;
  bookmarkPositionMs?: number;
  focusTurn?: { turnId: string; request: number };
  positions: ReadingPositions;
  connection?: RealtimeStatus;
  capturePhase?: CapturePhase;
  onSeek?: (positionMs: number) => void;
  playbackPositionMs?: number;
  onRename?: (speaker: string, anchor: HTMLElement) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const rows = useRef<ScrollRow[]>([]);
  const [newCount, setNewCount] = useState(0);
  const [following, setFollowing] = useState(true);
  const count = detail.turns.filter(turn => !turn.partial).length;

  function save(countRead?: number) {
    const el = element.current;
    if (!el || !el.clientHeight) return;
    const anchor = captureScrollAnchor(rows.current, el.scrollTop, el.scrollHeight, el.clientHeight, count);
    const previous = positions.get(detail.id);
    if (!anchor.following) anchor.confirmedCount = countRead ?? previous?.confirmedCount ?? count;
    positions.set(detail.id, anchor);
    setFollowing(anchor.following);
    setNewCount(detail.status === "recording" ? Math.max(0, count - anchor.confirmedCount) : 0);
  }

  useLayoutEffect(() => {
    const el = element.current;
    if (!el) return;
    const restore = () => {
      if (!el.clientHeight) return;
      const top = el.getBoundingClientRect().top;
      rows.current = Array.from(el.querySelectorAll<HTMLElement>("[data-turn-id]"), row => {
        const box = row.getBoundingClientRect();
        return { id: row.dataset.turnId!, timeMs: Number(row.dataset.timeMs),
          top: box.top - top + el.scrollTop, height: box.height };
      });
      const anchor = positions.get(detail.id);
      if (anchor) el.scrollTop = restoreScrollTop(anchor, rows.current, el.scrollHeight, el.clientHeight);
      save(anchor?.following ? count : anchor?.confirmedCount);
    };
    restore();
    const observer = new ResizeObserver(restore);
    observer.observe(el);
    // Inline editors and bookmark disclosure change content height without resizing the viewport.
    for (const content of Array.from(el.querySelectorAll(".turns, .bookmark-strip"))) observer.observe(content);
    return () => observer.disconnect();
  }, [detail.id, detail.status, detail.turns, positions]);

  useLayoutEffect(() => {
    if (!focusTurn) return;
    const el = element.current;
    const target = Array.from(el?.querySelectorAll<HTMLElement>("[data-turn-id]") ?? []).find(row => row.dataset.turnId === focusTurn.turnId);
    if (!el || !target) return;
    el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
    target.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    save(count);
  }, [focusTurn?.request, detail.id]);

  return <div className="transcript-view">
    <div className="scroll" ref={element} tabIndex={0} aria-label="完整转写" onScroll={() => save()}>
      {detail.transcriptToolsError && <p className="tool-error" role="status">{detail.transcriptToolsError}</p>}
      <details className="bookmark-strip" open={detail.status === "recording" ? true : undefined}>
        <summary>录音标记{detail.bookmarks?.length ? ` · ${detail.bookmarks.length}` : ""}</summary>
        <Bookmarks showHeading={false} key={detail.id} sessionId={detail.id} items={detail.bookmarks ?? []} positionMs={bookmarkPositionMs}
          onAdd={window.earshot.addBookmark} onDelete={window.earshot.deleteBookmark} onSeek={onSeek} />
      </details>
      {detail.turns.length === 0 && detail.status === "recording"
        ? <div className="empty-turns"><p>{capturePhase === "finalize_failed"
          ? "录音已停止，保存完成后可处理转写" : connection === "disconnected"
          ? "重新连接后继续转写后续音频" : connection === "reconnecting"
            ? "正在重新连接，录音继续" : "正在等待第一段转写"}</p></div>
        : <Turns turns={detail.turns} sessionId={detail.id} editable={editable} startedAt={detail.startedAt} variant="library" onRename={onRename} onSeek={onSeek} playbackPositionMs={playbackPositionMs} />}
    </div>
    {!following && detail.turns.length > 0 ? <button type="button" className="btn latest"
      onClick={() => {
        const el = element.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        save(count);
      }}>{newCount ? `${newCount} 段新内容 · ` : ""}回到最新</button> : null}
  </div>;
}
