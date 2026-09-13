import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ActionResult, SessionSummary } from '../shared/types';
import type { TranscriptSearchHit } from '../shared/transcript-tools';
import { sessionRemoval } from './session-removal';
import { isSameDay } from './format';
import { SearchPanel } from './SearchPanel';
import { SessionRow } from './SessionRow';
import { selectSessionRows, type SessionSelection } from './session-selection';

export function SessionList({ sessions, selectedId, navigation, settingsOn, onSelect, onSettings, onSearchSelect, searchRefreshKey }: {
  sessions: SessionSummary[]; selectedId: string | null; settingsOn: boolean;
  navigation: { id: string | null } | null;
  onSelect: (id: string) => void; onSettings: () => void;
  onSearchSelect: (hit: TranscriptSearchHit) => void; searchRefreshKey: string;
}) {
  const [filter, setFilter] = useState('all');
  const [searching, setSearching] = useState(false);
  const [selection, setSelection] = useState<SessionSelection>({ ids: selectedId ? [selectedId] : [], anchor: selectedId });
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const current = useRef(selection), deleting = useRef(false), list = useRef<HTMLDivElement>(null);
  const previousIds = useRef(sessions.map(row => row.id));
  const lastNavigation = useRef(navigation);
  const wasSettings = useRef(settingsOn);
  const visible = sessions.filter(row => filter === 'all' || (row.kind ?? 'recording') === filter);
  const now = new Date();
  const groups = [
    { label: '今天', rows: visible.filter(row => isSameDay(row.startedAt, now)) },
    { label: '更早', rows: visible.filter(row => !isSameDay(row.startedAt, now)) },
  ];
  const ids = groups.flatMap(group => group.rows.map(row => row.id));
  const visibleKey = JSON.stringify(ids);
  const chosen = settingsOn ? [] : selection.ids.filter(id => ids.includes(id));
  const externalBusy = useSyncExternalStore(sessionRemoval.subscribe, () => sessions.some(row => sessionRemoval.isPending(row.id)), () => false);
  const protectedSelection = sessions.some(row => chosen.includes(row.id) && row.status === 'recording');
  function update(next: SessionSelection) { current.current = next; setSelection(next); }

  useEffect(() => {
    const requested = navigation !== lastNavigation.current ? navigation?.id : null;
    const newlyOpened = selectedId && !previousIds.current.includes(selectedId) ? selectedId : null;
    const returning = wasSettings.current && !settingsOn && !current.current.ids.length ? selectedId : null;
    previousIds.current = sessions.map(row => row.id); wasSettings.current = settingsOn;
    // A snapshot acknowledges data, not a selection gesture. Only explicit navigation
    // (or a newly created session) can replace a selection made in this list.
    const target = requested ?? newlyOpened ?? returning;
    if (requested && sessions.some(row => row.id === requested) && !ids.includes(requested)) setFilter('all');
    if (!requested || ids.includes(requested)) lastNavigation.current = navigation;
    const next = current.current.ids.filter(id => ids.includes(id));
    if (settingsOn) update({ ids: [], anchor: null });
    else if (!deleting.current && target && ids.includes(target) && (requested || !next.includes(target))) {
      update({ ids: [target], anchor: target });
    } else if (JSON.stringify(next) !== JSON.stringify(current.current.ids)) {
      update({ ids: next, anchor: current.current.anchor && ids.includes(current.current.anchor) ? current.current.anchor : next[0] ?? null });
    }
  }, [navigation, selectedId, settingsOn, visibleKey]);

  function select(id: string, modifiers: { metaKey?: boolean; shiftKey?: boolean } = {}) {
    if (deleting.current) return;
    const next = selectSessionRows(current.current, ids, id, modifiers);
    update(next); setError(null);
    if (next.ids.includes(id)) onSelect(id);
  }

  async function remove(targets: string[]): Promise<ActionResult> {
    if (deleting.current) return { ok: false, error: '正在删除，请稍候' };
    // Freeze this action's visible targets before the first IPC can change the list.
    const rows = visible.filter(row => targets.includes(row.id));
    if (!rows.length) return { ok: false, error: '请先选择会话' };
    if (rows.some(row => row.status === 'recording')) return { ok: false, error: '请先停止录制并保存' };
    deleting.current = true; setBusy(true); setError(null);
    const failed: string[] = [], messages: string[] = [];
    try {
      for (const row of rows) {
        try {
          const result = await sessionRemoval.remove(row.id);
          if (!result.ok) { failed.push(row.id); messages.push(result.error); }
        } catch { failed.push(row.id); messages.push('操作未完成，请重试'); }
      }
      update({ ids: failed, anchor: failed[0] ?? null });
      const message = failed.length ? `${failed.length === 1 ? '会话未删除' : `${failed.length} 场会话未删除`}。${[...new Set(messages)].join('；')}` : null;
      setError(message);
      requestAnimationFrame(() => list.current?.focus());
      return message ? { ok: false, error: message } : { ok: true };
    } finally { deleting.current = false; setBusy(false); }
  }

  return <aside className={`slist${searching ? ' searching' : ''}`}>
    <SearchPanel search={window.earshot.searchTranscripts} onSelect={hit => {
      setFilter('all'); update({ ids: [hit.sessionId], anchor: hit.sessionId }); onSearchSelect(hit);
    }} refreshKey={searchRefreshKey} onActiveChange={setSearching} />
    <div className="session-filter" role="group" aria-label="筛选会话" hidden={searching}>
      {([['all', '全部'], ['recording', '录制'], ['dictation', '输入']] as const).map(([value, label]) =>
        <button key={value} type="button" disabled={busy} aria-pressed={filter === value} onClick={() => {
          setFilter(value); setError(null);
          const next = sessions.filter(row => value === 'all' || (row.kind ?? 'recording') === value);
          const id = next.find(row => row.id === selectedId)?.id ?? next[0]?.id ?? null;
          update({ ids: id && !settingsOn ? [id] : [], anchor: id });
          if (id && !settingsOn && id !== selectedId) onSelect(id);
        }}>{label}</button>)}
    </div>
    <div ref={list} className="sl-main" tabIndex={0} aria-label="会话列表" hidden={searching} onKeyDown={event => {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, [contenteditable="true"], .name-editor')) return;
      if (busy) return;
      if (event.metaKey && event.key.toLowerCase() === 'a') {
        event.preventDefault(); update({ ids, anchor: current.current.anchor ?? ids[0] ?? null });
        if (settingsOn && ids[0]) onSelect(ids[0]);
      }
      if (event.metaKey && event.key === 'Backspace' && chosen.length) {
        event.preventDefault(); if (!protectedSelection) void remove(chosen);
      }
      if (event.key === 'Escape') { event.preventDefault(); update({ ids: [], anchor: null }); setError(null); }
    }}>
      {!visible.length && <p className="why filter-empty">暂无此类会话</p>}
      {groups.map(group => group.rows.length > 0 && <div className="session-group" key={group.label}>
        <div className="sl-group">{group.label}</div>
        <div className="session-group-rows">{group.rows.map(row => {
          const targets = chosen.includes(row.id) ? chosen : [row.id];
          return <SessionRow key={row.id} row={row} selected={chosen.includes(row.id)} active={row.id === selectedId && !settingsOn}
            onSelect={select} onContextSelect={() => {
              if (!chosen.includes(row.id)) { update({ ids: [row.id], anchor: row.id }); onSelect(row.id); }
            }} deleteTargets={targets} deletionBlocked={busy || externalBusy || sessions.some(item => targets.includes(item.id) && item.status === 'recording')}
            interactionDisabled={busy || externalBusy} onDelete={remove} />;
        })}</div>
      </div>)}
    </div>
    {!searching && (chosen.length > 1 || error || busy) && <div className="session-selection-bar" aria-busy={busy}>
      {(chosen.length > 1 || busy) && <div className="session-selection-actions"><span role="status">{busy ? '正在删除会话…' : `已选择 ${chosen.length} 场会话`}</span>
        {!error && <button type="button" disabled={busy || !chosen.length || protectedSelection} onClick={() => void remove(chosen)}>删除</button>}</div>}
      {protectedSelection && !busy && <p className="tool-hint">选中了正在录制的会话，请先停止并保存。</p>}
      {error && <div className="selection-error"><p className="field-err" role="alert">{error}</p><div className="selection-error-actions"><button className="btn ghost" disabled={busy || !chosen.length || protectedSelection} onClick={() => void remove(chosen)}>重试删除</button><button className="btn text" disabled={busy} onClick={() => setError(null)}>关闭提示</button></div></div>}
    </div>}
    <div className="sl-foot"><button type="button" className={`sl-row${settingsOn ? ' on' : ''}`} aria-current={settingsOn ? 'page' : undefined} onClick={onSettings}>
      <span className="sl-title">设置</span>
    </button></div>
  </aside>;
}
