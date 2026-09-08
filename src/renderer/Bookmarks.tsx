import { useId, useState } from "react";
import type { ActionResult } from "../shared/types";
import type { AddBookmarkInput, Bookmark, DeleteBookmarkInput } from "../shared/transcript-tools";
import { formatClock } from "./format";
import "./transcript-tools.css";

type Props = {
  sessionId: string;
  showHeading?: boolean;
  items: Bookmark[];
  positionMs?: number;
  onAdd: (input: AddBookmarkInput) => Promise<ActionResult>;
  onDelete: (input: DeleteBookmarkInput) => Promise<ActionResult>;
  onSeek?: (positionMs: number) => void;
};
export function Bookmarks({ sessionId, items, positionMs, onAdd, onDelete, onSeek, showHeading = true }: Props) {
  const labelId = useId();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  async function run(bookmarkId?: string) {
    if (busy || (!bookmarkId && positionMs === undefined)) return;
    setBusy(true); setFeedback("");
    try {
      const result = bookmarkId ? await onDelete({ sessionId, bookmarkId }) : await onAdd({ sessionId, tStartMs: Math.round(positionMs!), label });
      if (result.ok) { if (!bookmarkId) setLabel(""); setFeedback(bookmarkId ? "标记已删除" : "已添加标记"); }
      else setFeedback(result.error);
    } catch { setFeedback("标记没能保存，请重试"); }
    finally { setBusy(false); }
  }
  return <section className="transcript-bookmarks" aria-label="录音标记">
    {showHeading && <div className="tool-heading"><strong>标记{items.length ? ` · ${items.length}` : ""}</strong><span className="tool-hint">方便稍后回听</span></div>}
    {positionMs !== undefined && <form className="bookmark-add" onSubmit={event => { event.preventDefault(); void run(); }}>
      <label className="sr-only" htmlFor={labelId}>标记名称，可留空</label>
      <input id={labelId} placeholder="标记名称（可留空）" value={label} maxLength={80} disabled={busy} onChange={event => setLabel(event.target.value)} />
      <button type="submit" disabled={busy}>标记 {formatClock(positionMs / 1000)}</button>
    </form>}
    {feedback && <p className="tool-hint" role="status">{feedback}</p>}
    {items.length > 0 ? <ul>{items.map((bookmark, index) => <li key={bookmark.id}>
      <button type="button" className="bookmark-seek" disabled={!onSeek} onClick={() => onSeek?.(bookmark.tStartMs)} aria-label={`回听标记 ${bookmark.label || index + 1}，${formatClock(bookmark.tStartMs / 1000)}`}>
        <time>{formatClock(bookmark.tStartMs / 1000)}</time><span>{bookmark.label || `标记 ${index + 1}`}</span>
      </button>
      <button type="button" className="tool-text-button" disabled={busy} aria-label={`删除标记 ${bookmark.label || index + 1}`} onClick={() => void run(bookmark.id)}>删除</button>
    </li>)}</ul> : <p className="tool-hint">{positionMs === undefined ? "播放录音时可在当前位置添加标记。" : "听到重要内容时，添加一个标记。"}</p>}
  </section>;
}
