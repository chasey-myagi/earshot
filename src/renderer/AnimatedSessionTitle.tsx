import { useLayoutEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../shared/types';

type Title = Pick<SessionSummary, 'id' | 'title' | 'titleSource' | 'titleRevision'>;

/** Animate a new automatic name only while this same session is on screen. */
export function AnimatedSessionTitle({ value }: { value: Title }) {
  const previous = useRef(value);
  const [leaving, setLeaving] = useState<string | null>(null);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = value;
    const changed = before.id === value.id && before.title !== value.title
      && value.titleSource === 'auto' && value.titleRevision !== before.titleRevision;
    if (!changed || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setLeaving(null);
      return;
    }
    setLeaving(before.title);
    const timer = window.setTimeout(() => setLeaving(null), 260);
    return () => window.clearTimeout(timer);
  }, [value.id, value.title, value.titleSource, value.titleRevision]);
  return <span className={`animated-session-title${leaving !== null ? ' is-renaming' : ''}`}>
    {leaving !== null && <span className="title-leaving" aria-hidden="true">{leaving}</span>}
    <span className="title-current">{value.title}</span>
  </span>;
}
