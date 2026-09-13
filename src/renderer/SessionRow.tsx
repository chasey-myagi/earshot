import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ActionResult, AppSnapshot, SessionSummary } from '../shared/types';
import { formatDurationShort, formatListWhen, formatStartTime } from './format';
import { sessionSideHint } from './sessionSide';
import { NameEditor } from './NameEditor';
import { sessionRemoval } from './session-removal';
import { usePresence } from './usePresence';
import { AnimatedSessionTitle } from './AnimatedSessionTitle';

export function SessionRow({ row, selected, active = selected, onSelect, titleOnly = false, onContextSelect, deleteTargets = [row.id], deletionBlocked = false, interactionDisabled = false, onDelete }: {
  row: SessionSummary; selected: boolean; active?: boolean; titleOnly?: boolean;
  onSelect: (id: string, modifiers?: { metaKey?: boolean; shiftKey?: boolean }) => void;
  onContextSelect?: () => void; deleteTargets?: string[]; deletionBlocked?: boolean; interactionDisabled?: boolean;
  onDelete?: (ids: string[]) => Promise<ActionResult>;
}) {
  const [point, setPoint] = useState<{ left: number; top: number } | null>(null);
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(row.title);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const removing = useSyncExternalStore(sessionRemoval.subscribe, () => sessionRemoval.isPending(row.id), () => false);
  const presence = usePresence(Boolean(point));
  const lastPoint = useRef(point);
  if (point) lastPoint.current = point;
  const pending = useRef(false), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const attempt = useRef(0), currentId = useRef(row.id);
  const menuTargets = useRef(deleteTargets);
  currentId.current = row.id;
  useEffect(() => { attempt.current += 1; pending.current = false; setEditing(false); setBusy(false); setError(null); }, [row.id]);
  useEffect(() => () => { attempt.current += 1; }, []);
  function cancelRename() { setEditing(false); setError(null); requestAnimationFrame(() => trigger.current?.focus()); }
  const recording = row.status === 'recording';
  const typeLabel = row.kind === 'dictation' ? '语音输入' : '语音录制';
  function close(focus = false) { setPoint(null); if (focus) trigger.current?.focus(); }
  function rename() {
    if (recording || busy || removing || interactionDisabled) return;
    close(); onSelect(row.id); setError(null); setDraft(row.title); setEditing(true);
  }
  function open(position?: { left: number; top: number }) {
    if (interactionDisabled || removing || !trigger.current) return;
    menuTargets.current = [...deleteTargets]; onContextSelect?.();
    const rect = trigger.current.getBoundingClientRect();
    setPoint({ left: Math.max(8, Math.min(position?.left ?? rect.left, innerWidth - 208)), top: Math.max(8, Math.min(position?.top ?? rect.bottom + 4, innerHeight - 56)) });
  }
  useEffect(() => {
    if (!point) return;
    (menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu.current)?.focus();
    const outside = (event: PointerEvent) => {
      // A row click changes the selection, so its old menu must close first.
      // The title's separate menu button keeps its normal click-to-toggle behavior.
      if (!menu.current?.contains(event.target as Node) && !(titleOnly && trigger.current?.contains(event.target as Node))) close();
    };
    const dismiss = () => close();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, [point]);
  async function act(action: 'delete' | 'rename') {
    if (pending.current) return;
    if (action === 'rename' && (!draft.trim() || draft.trim() === row.title.trim())) return;
    const request = ++attempt.current, sessionId = row.id;
    close(action !== 'rename'); pending.current = true; setBusy(true); setError(null);
    try {
      const result = action === 'delete'
        ? onDelete ? await onDelete(menuTargets.current) : await sessionRemoval.remove(row.id)
        : await window.earshot.renameSession({ sessionId: row.id, title: draft.trim() });
      if (attempt.current !== request || currentId.current !== sessionId) return;
      if (!result.ok && !(action === 'delete' && onDelete)) setError(result.error);
      else if (action === 'rename') { cancelRename(); }
    } catch { if (attempt.current === request && currentId.current === sessionId) setError('操作未完成，请重试'); }
    finally { if (attempt.current === request && currentId.current === sessionId) { pending.current = false; setBusy(false); } }
  }
  const hint = sessionSideHint(row.jobs);
  return <div data-session-id={row.id} className={`${titleOnly ? 'session-title' : 'session-row'}${selected ? ' selected' : ''}`} onContextMenu={event => { if (!editing) { event.preventDefault(); open({ left: event.clientX, top: event.clientY }); } }}>
    {editing ? <div className="session-row-edit"><NameEditor label="会话名称" value={draft} original={row.title} maxLength={160} busy={busy} error={error}
      onChange={value => { setDraft(value); setError(null); }} onSave={() => void act('rename')} onCancel={cancelRename} /></div> : titleOnly ? <h2 title={recording ? row.title : `${row.title}（双击改名）`} onDoubleClick={rename}><AnimatedSessionTitle value={row} /></h2> : <button ref={trigger} type="button" className={`sl-row${selected ? ' on' : ''}`} aria-pressed={selected} aria-current={active ? 'page' : undefined}
      aria-disabled={interactionDisabled || undefined} onClick={event => { if (!interactionDisabled) onSelect(row.id, event); }} onDoubleClick={event => { if (!event.metaKey && !event.shiftKey) rename(); }} onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); open(); }
        if (event.key === 'Enter' && !event.metaKey && !event.shiftKey) { event.preventDefault(); rename(); }
      }}>
      <span className="session-type" title={typeLabel} aria-label={typeLabel}><svg viewBox="0 0 24 24" aria-hidden="true">{row.kind === "dictation" ? <path d="M4 5h16M4 10h16M4 15h10M4 20h7" /> : <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" /></>}</svg></span>
      <span className="sl-title" title={row.title}><AnimatedSessionTitle value={row} /></span>
      <span className="sl-meta">{formatListWhen(row.startedAt)} {formatStartTime(row.startedAt)} · {formatDurationShort(row.durationSec)}{hint ? ` · ${hint}` : ''}</span>
    </button>}
    {titleOnly && !editing && <button ref={trigger} type="button" className="session-title-menu" aria-label={`操作会话：${row.title}`} aria-haspopup="menu" aria-expanded={Boolean(point)} disabled={busy || removing}
      onClick={() => point ? close() : open()} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } if (event.key === 'F2') { event.preventDefault(); rename(); } }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></button>}
    {error && !editing && <p className="field-err" role="alert">{error}</p>}
    {presence.present && createPortal(<div ref={menu} tabIndex={-1} className={`session-menu t-dropdown ${presence.className}`} inert={!point} aria-hidden={!point} role="menu" aria-label="会话操作" style={lastPoint.current ?? undefined} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); close(true); }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }}>
      <button type="button" role="menuitem" className="danger" disabled={recording || deletionBlocked || removing} title={recording ? '请先停止录制并保存' : deletionBlocked || removing ? '正在删除，请稍候' : undefined} onClick={() => void act('delete')}>{menuTargets.current.length > 1 ? `删除 ${menuTargets.current.length} 个会话` : '删除'}</button>
    </div>, document.body)}
  </div>;
}

export function DeletionNotices({ values }: { values: NonNullable<AppSnapshot['deletions']> }) {
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const visible = Boolean(values.length || busy || error);
  const presence = usePresence(visible, "--toast-close");
  const lastMessage = useRef('');
  const failed = values.some(value => value.error);
  if (visible) lastMessage.current = `${failed ? '部分会话未能移到废纸篓，仍保留在本机。' : busy ? '正在恢复会话…' : !values.length ? '恢复未完成' : values.length === 1 ? `已删除「${values[0].title}」` : `已删除 ${values.length} 场会话`}${error ? ` · ${error}` : ''}`;
  if (!presence.present) return null;
  return <div className={`name-undo deletion-notice t-toast ${presence.className}`} inert={!visible} aria-hidden={!visible}>
    <p role="status">{lastMessage.current}</p>
    {values.length > 0 && <button type="button" className="btn ghost" disabled={busy} onClick={async () => {
      if (pending.current) return; pending.current = true; setBusy(true); setError(null);
      const targets = values.map(value => value.sessionId);
      try {
        const results = await Promise.all(targets.map(id => window.earshot.undoDeleteSession(id).catch(() => ({ ok: false as const, error: '恢复未完成，请重试' }))));
        const failures = results.filter(result => !result.ok);
        if (failures.length) setError(`${failures.length === 1 ? '会话' : `${failures.length} 场会话`}未恢复，请检查废纸篓或重试。`);
      } finally { pending.current = false; setBusy(false); }
    }}>{busy ? '恢复中…' : failed ? '恢复会话' : '撤销'}</button>}{error && <button type="button" className="btn text" onClick={() => setError(null)}>关闭提示</button>}
  </div>;
}
