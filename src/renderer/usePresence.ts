import { useEffect, useState } from 'react';

/** Retain closing surfaces for their CSS exit, cancel stale cleanup on reopening. */
export function usePresence(open: boolean, closeToken = '--dropdown-close-dur') {
  const [retained, setRetained] = useState(open);
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (open) {
      setRetained(true);
      const frame = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(frame);
    }
    setEntered(false);
    const style = getComputedStyle(document.documentElement).getPropertyValue(closeToken).trim();
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : (parseFloat(style) || 0) * (style.endsWith('ms') ? 1 : 1000);
    const timer = setTimeout(() => setRetained(false), duration);
    return () => clearTimeout(timer);
  }, [open, closeToken]);
  return { present: open || retained, className: open ? entered ? 'is-open' : '' : 'is-closing' };
}
