import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppSnapshot, SessionSummary } from '../shared/types';
import { formatDurationShort, formatListWhen, formatStartTime } from './format';
import { sessionSideHint } from './sessionSide';

export function SessionRow({ row, selected, onSelect, titleOnly = false }: { row: SessionSummary; selected: boolean; onSelect: (id: string) => void; titleOnly?: boolean }) {
  const [point, setPoint] = useState<{ left: number; top: number } | null>(null);
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(row.title);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const pending = useRef(false), trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  const recording = row.status === 'recording';
  const typeLabel = row.kind === 'dictation' ? '语音输入' : '语音录制';
  function close(focus = false) { setPoint(null); if (focus) trigger.current?.focus(); }
  function open() {
    const rect = trigger.current!.getBoundingClientRect();
    setPoint({ left: Math.max(8, Math.min(rect.left, innerWidth - 208)), top: Math.max(8, Math.min(rect.bottom + 4, innerHeight - 145)) });
  }
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);
  useEffect(() => {
    if (!point) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(); };
    const dismiss = () => close();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, [point]);
  async function act(action: 'delete' | 'reveal' | 'rename') {
    if (pending.current) return;
    close(true); pending.current = true; setBusy(true); setError(null);
    try {
      const result = action === 'delete' ? await window.earshot.deleteSession(row.id)
        : action === 'reveal' ? await window.earshot.revealSession(row.id)
          : await window.earshot.renameSession({ sessionId: row.id, title: draft });
      if (!result.ok) setError(result.error);
      else if (action === 'rename') { setEditing(false); trigger.current?.focus(); }
    } catch { setError('操作未完成，请重试'); }
    finally { pending.current = false; setBusy(false); }
  }
  const hint = sessionSideHint(row.jobs);
  return <div className={`${titleOnly ? 'session-title' : 'session-row'}${selected ? ' selected' : ''}`} onContextMenu={event => { if (!editing) { event.preventDefault(); open(); } }}>
    {editing ? <form className="session-row-edit" onSubmit={event => { event.preventDefault(); void act('rename'); }}>
      <input ref={input} aria-label="会话名称" value={draft} disabled={busy} maxLength={160} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); setEditing(false); trigger.current?.focus(); } }} />
      <button className="btn text" disabled={busy || !draft.trim()}>保存</button>
      <button type="button" className="btn text" disabled={busy} onClick={() => setEditing(false)}>取消</button>
    </form> : titleOnly ? <h2 title={row.title}>{row.title}</h2> : <button ref={trigger} type="button" className={`sl-row${selected ? ' on' : ''}`} aria-current={selected ? 'page' : undefined} onClick={() => onSelect(row.id)} onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); open(); } }}>
      <span className="session-type" title={typeLabel} aria-label={typeLabel}><svg viewBox="0 0 24 24" aria-hidden="true">{row.kind === "dictation" ? <path d="M4 5h16M4 10h16M4 15h10M4 20h7" /> : <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" /></>}</svg></span>
      <span className="sl-title" title={row.title}>{row.title}</span>
      <span className="sl-meta">{formatListWhen(row.startedAt)} {formatStartTime(row.startedAt)} · {formatDurationShort(row.durationSec)}{hint ? ` · ${hint}` : ''}</span>
    </button>}
    {titleOnly && <button ref={trigger} type="button" className="session-title-menu" aria-label={`操作会话：${row.title}`} aria-haspopup="menu" aria-expanded={Boolean(point)} disabled={busy}
      onClick={() => point ? close() : open()} onKeyDown={event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); } }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></button>}
    {error && <p className="field-err" role="alert">{error}</p>}
    {point && createPortal(<div ref={menu} className="session-menu" role="menu" aria-label="会话操作" style={point} onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); close(true); }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }}>
      <button type="button" role="menuitem" disabled={recording} onClick={() => { close(); setDraft(row.title); setEditing(true); }}>改名</button>
      <button type="button" role="menuitem" onClick={() => void act('reveal')}>在访达中显示</button>
      <button type="button" role="menuitem" className="danger" disabled={recording} title={recording ? '请先停止录制并保存' : undefined} onClick={() => void act('delete')}>{recording ? '请先停止录制' : '删除会话…'}</button>
    </div>, document.body)}
  </div>;
}

export function DeletionNotices({ values }: { values: NonNullable<AppSnapshot['deletions']> }) {
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null);
  return <>{values.map(value => <div className="name-undo" key={value.sessionId}>
    <p role="status">{value.error ?? `已删除「${value.title}」，8 秒内可撤销`}{error ? ` · ${error}` : ''}</p>
    <button type="button" className="btn ghost" disabled={busy !== null} onClick={async () => {
      if (busy) return; setBusy(value.sessionId); setError(null);
      try { const result = await window.earshot.undoDeleteSession(value.sessionId); if (!result.ok) setError(result.error); }
      catch { setError('恢复未完成，请重试'); }
      finally { setBusy(null); }
    }}>{busy === value.sessionId ? '恢复中…' : value.error ? '恢复会话' : '撤销'}</button>
  </div>)}</>;
}
