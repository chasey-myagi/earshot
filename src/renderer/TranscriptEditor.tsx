import { useEffect, useId, useRef, useState } from "react";
import type { ActionResult, TranscriptTurn } from "../shared/types";
import type { CorrectTurnInput, TurnCorrectionInput } from "../shared/transcript-tools";
import { formatClock } from "./format";
import "./transcript-tools.css";

type Props = {
  sessionId: string;
  turn: TranscriptTurn;
  onSave: (input: CorrectTurnInput) => Promise<ActionResult>;
  onUndo: (input: TurnCorrectionInput) => Promise<ActionResult>;
  onReset: (input: TurnCorrectionInput) => Promise<ActionResult>;
  onClose: () => void;
};
export function TranscriptEditor({ sessionId, turn, onSave, onUndo, onReset, onClose }: Props) {
  const prefix = useId();
  const [draft, setDraft] = useState({ sessionId, turnId: turn.id, text: turn.text, speaker: turn.speaker, revision: turn.correction?.revision });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false), composing = useRef(false), active = useRef(true);
  const scope = `${sessionId}:${turn.id}`, currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const changed = draft.text !== turn.text || draft.speaker.trim() !== turn.speaker.trim();
  const stale = draft.sessionId !== sessionId || draft.turnId !== turn.id || draft.revision !== turn.correction?.revision;
  const unavailable = !turn.correction;
  async function run(action: "save" | "undo" | "reset") {
    if (inFlight.current || stale || !draft.revision || (action === "save" && (!changed || !draft.text.trim() || !draft.speaker.trim()))) return;
    inFlight.current = true;
    const requestScope = scope;
    setBusy(true); setError("");
    try {
      const input = { sessionId, turnId: turn.id, revision: draft.revision };
      const result = action === "save" ? await onSave({ ...input, text: draft.text, speaker: draft.speaker.trim() }) :
        action === "undo" ? await onUndo(input) : await onReset(input);
      if (!active.current || currentScope.current !== requestScope) return;
      if (result.ok) onClose(); else setError(result.error);
    } catch { if (active.current && currentScope.current === requestScope) setError("修改没能保存，请重试"); }
    finally { if (active.current && currentScope.current === requestScope) { inFlight.current = false; setBusy(false); } }
  }
  return <form className="transcript-editor" aria-label={`修改 ${formatClock(turn.tStartMs / 1000)} 这一段`} aria-busy={busy} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) { if (event.key === "Enter") event.preventDefault(); return; }
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); void run("save"); }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!inFlight.current) onClose(); }
    }} onSubmit={event => { event.preventDefault(); if (!composing.current) void run("save"); }}>
    <div className="tool-heading"><strong>修改这一段 · {formatClock(turn.tStartMs / 1000)}</strong><button type="button" className="tool-text-button" disabled={busy} onClick={onClose}>取消</button></div>
    <p className="tool-hint">只修改这一段。说话人姓名不会登记为声纹。</p>
    <label htmlFor={`${prefix}-speaker`}>这一段的说话人</label>
    <input id={`${prefix}-speaker`} autoFocus value={draft.speaker} maxLength={80} disabled={busy || unavailable} onChange={event => setDraft({ ...draft, speaker: event.target.value })} />
    <label htmlFor={`${prefix}-text`}>正文</label>
    <textarea id={`${prefix}-text`} rows={4} value={draft.text} maxLength={20_000} disabled={busy || unavailable} onChange={event => setDraft({ ...draft, text: event.target.value })} />
    {stale && <p className="tool-error" role="alert">这段转写已更新。<button type="button" className="tool-text-button" disabled={busy} onClick={() => { setDraft({ sessionId, turnId: turn.id, text: turn.text, speaker: turn.speaker, revision: turn.correction?.revision }); setError(""); }}>载入最新内容</button></p>}
    {unavailable && <p className="tool-error" role="alert">这段暂时无法编辑，请查看转写提示。</p>}
    {error && <p className="tool-error" role="alert">{error}</p>}
    {turn.correction?.edited && <details className="transcript-original"><summary>查看原始转写</summary><p>{turn.correction.originalSpeaker}：{turn.correction.originalText}</p></details>}
    <div className="tool-actions">
      <button type="button" disabled={busy || stale || !turn.correction?.canUndo} onClick={() => void run("undo")}>撤销上次修改</button>
      <button type="button" disabled={busy || stale || !turn.correction?.edited} onClick={() => void run("reset")}>恢复原稿</button>
      <button type="submit" className="tool-primary" disabled={busy || stale || unavailable || !changed || !draft.text.trim() || !draft.speaker.trim()}>{busy ? "保存中…" : "保存修改"}</button>
    </div>
  </form>;
}
