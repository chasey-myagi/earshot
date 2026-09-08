import { useEffect, useRef, useState } from "react";
import type { TranscriptSearchHit, TranscriptSearchInput, TranscriptSearchResult } from "../shared/transcript-tools";
import { formatClock } from "./format";
import "./transcript-tools.css";

type Props = {
  search: (input: TranscriptSearchInput) => Promise<TranscriptSearchResult>;
  onSelect: (hit: TranscriptSearchHit) => void;
  refreshKey?: string | number;
};
export function SearchPanel({ search, onSelect, refreshKey }: Props) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<TranscriptSearchResult | null>(null);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const searchRef = useRef(search);
  searchRef.current = search;
  useEffect(() => {
    const request = ++generation.current;
    if (!query.trim()) { setResult(null); setPending(false); return; }
    setPending(true);
    const timer = setTimeout(() => {
      void searchRef.current({ query, limit: 50 }).then(value => {
        if (request === generation.current) { setResult(value); setPending(false); }
      }).catch(() => {
        if (request === generation.current) { setResult({ ok: false, error: "搜索暂时不可用，请重试" }); setPending(false); }
      });
    }, 180);
    return () => { clearTimeout(timer); generation.current += 1; };
  }, [query, refreshKey]);
  return <section className="transcript-search" aria-label="搜索会库">
    <div className="transcript-search-field">
      <input type="search" aria-label="搜索标题、正文或说话人" placeholder="搜索标题、正文、说话人" value={query} maxLength={200}
        onChange={event => { setQuery(event.target.value); setResult(null); }} />
      {query && <button type="button" className="tool-text-button" onClick={() => setQuery("")} aria-label="清空搜索">清空</button>}
    </div>
    {query.trim() && <div className="transcript-search-results" aria-busy={pending}>
      <p className="tool-hint" role="status">{pending ? "搜索中…" : result?.ok ? result.hits.length ? `${result.hits.length} 条结果${result.truncated ? "，可添加关键词缩小范围" : ""}` : "没有找到相关内容" : result?.error}</p>
      {!pending && result?.ok && <ul>{result.hits.map(hit => <li key={`${hit.sessionId}:${hit.turnId ?? "title"}`}>
        <button type="button" className="search-hit" onClick={() => onSelect(hit)}>
          <strong>{hit.sessionTitle}</strong>
          {hit.turnId !== null && <span className="search-hit-meta">{hit.speaker} · {formatClock((hit.tStartMs ?? 0) / 1000)}</span>}
          <span className="search-hit-snippet">{hit.snippet}</span>
        </button>
      </li>)}</ul>}
    </div>}
  </section>;
}
