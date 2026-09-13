import { useEffect, useId, useRef, useState } from "react";
import type { TranscriptSearchHit, TranscriptSearchInput, TranscriptSearchResult } from "../shared/transcript-tools";
import { formatClock } from "./format";
import { CloseIcon, SearchIcon } from "./icons";
import "./transcript-tools.css";

type Props = {
  search: (input: TranscriptSearchInput) => Promise<TranscriptSearchResult>;
  onSelect: (hit: TranscriptSearchHit) => void;
  onActiveChange?: (active: boolean) => void;
  refreshKey?: string | number;
};
function Highlight({ text, query }: { text: string; query: string }) {
  const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return <>{text.split(pattern).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>;
}
export function SearchPanel({ search, onSelect, onActiveChange, refreshKey }: Props) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<TranscriptSearchResult | null>(null);
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null), results = useRef<HTMLDivElement>(null);
  const generation = useRef(0), searchRef = useRef(search);
  searchRef.current = search;
  const id = useId(), trimmed = query.trim(), active = Boolean(trimmed);
  function change(value: string) {
    generation.current += 1;
    setQuery(value); setResult(null); setSelected(null);
    onActiveChange?.(Boolean(value.trim()));
  }
  function clear() { change(""); input.current?.focus(); }
  useEffect(() => {
    function focus(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !event.isComposing) {
        event.preventDefault(); input.current?.focus(); input.current?.select();
      }
    }
    window.addEventListener('keydown', focus);
    return () => window.removeEventListener('keydown', focus);
  }, []);
  useEffect(() => {
    const request = ++generation.current;
    if (!trimmed) { setResult(null); setPending(false); return; }
    setPending(true);
    const timer = setTimeout(() => {
      void searchRef.current({ query: trimmed, limit: 50 }).then(value => {
        if (request === generation.current) { setResult(value); setPending(false); }
      }).catch(() => {
        if (request === generation.current) { setResult({ ok: false, error: "搜索暂时不可用，请重试" }); setPending(false); }
      });
    }, 180);
    return () => { clearTimeout(timer); generation.current += 1; };
  }, [query, refreshKey, retry]);
  const groups = new Map<string, TranscriptSearchHit[]>();
  if (result?.ok) for (const hit of result.hits) groups.set(hit.sessionId, [...(groups.get(hit.sessionId) ?? []), hit]);
  function choose(hit: TranscriptSearchHit) { setSelected(`${hit.sessionId}:${hit.turnId}`); onSelect(hit); }
  return <section className={`transcript-search${active ? ' active' : ''}`} aria-label="搜索会话" onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); clear(); }
    const items = Array.from(results.current?.querySelectorAll<HTMLButtonElement>('.search-hit') ?? []);
    if (event.target === input.current) {
      if (event.key === 'ArrowDown' && items.length) { event.preventDefault(); items[0].focus(); }
      if (event.key === 'Enter' && result?.ok && result.hits.length) { event.preventDefault(); choose(result.hits[0]); }
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.includes(event.target as HTMLButtonElement)) {
      event.preventDefault();
      const index = items.indexOf(event.target as HTMLButtonElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }
  }}>
    <div className="transcript-search-field">
      <SearchIcon />
      <input ref={input} type="search" aria-label="搜索标题、正文或说话人" aria-controls={active ? id : undefined} placeholder="搜索会话" value={query} maxLength={200}
        onChange={event => change(event.target.value)} />
      {query ? <button type="button" className="icon-button search-clear" onClick={clear} aria-label="清空搜索"><CloseIcon /></button> : <kbd aria-hidden="true">⌘ F</kbd>}
    </div>
    {active && <div ref={results} id={id} className="transcript-search-results" aria-busy={pending}>
      <p className="search-summary" role="status">{pending && !result ? "正在搜索…" : result?.ok ? result.hits.length ? <><b>{groups.size} 场会话</b><span> · {result.hits.length} 处匹配</span></> : "没有找到相关内容" : "搜索未完成"}</p>
      {!pending && result && !result.ok && <div className="search-empty"><p>{result.error}</p><button className="btn ghost" onClick={() => setRetry(value => value + 1)}>重新搜索</button></div>}
      {!pending && result?.ok && !result.hits.length && <div className="search-empty"><p>试试标题中的词、人名，或一句话中的关键词。</p><button className="btn text" onClick={clear}>返回会话</button></div>}
      {[...groups].map(([sessionId, hits]) => {
        const titleHit = hits.find(hit => hit.turnId === null);
        return <section className="search-group" key={sessionId} aria-label={hits[0].sessionTitle}>
        <h3>{titleHit ? <button type="button" className="search-hit search-group-title" aria-label={`打开会话：${titleHit.sessionTitle}`} aria-current={selected === `${sessionId}:null` ? 'true' : undefined} onClick={() => choose(titleHit)}><Highlight text={titleHit.sessionTitle} query={trimmed} /></button> : <span title={hits[0].sessionTitle}><Highlight text={hits[0].sessionTitle} query={trimmed} /></span>}<small>{titleHit && hits.length === 1 ? '标题' : `${hits.length} 处`}</small></h3>
        {hits.filter(hit => hit.turnId !== null).map(hit => <button key={`${hit.sessionId}:${hit.turnId ?? 'title'}`} type="button" className="search-hit" aria-current={selected === `${hit.sessionId}:${hit.turnId}` ? 'true' : undefined} onClick={() => choose(hit)}>
          <span className="search-hit-meta">{hit.turnId !== null ? <><Highlight text={hit.speaker ?? ""} query={trimmed} /> · <time>{formatClock((hit.tStartMs ?? 0) / 1000)}</time></> : '标题匹配'}</span>
          <span className="search-hit-snippet"><Highlight text={hit.snippet} query={trimmed} /></span>
        </button>)}
      </section>; })}
      {!pending && result?.ok && result.truncated && <p className="tool-hint search-limit">已显示前 50 处匹配，添加关键词可缩小范围。</p>}
    </div>}
  </section>;
}
