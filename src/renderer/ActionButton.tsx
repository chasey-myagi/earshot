import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import type { ActionResult } from '../shared/types';

/** Small system actions keep their failure beside the control that initiated them. */
export function ActionButton({ action, failure, children, disabled, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  action: () => Promise<ActionResult | void>; failure: string;
}) {
  const pending = useRef(false), active = useRef(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function run() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const result = await action();
      if (active.current && result && !result.ok) setError(result.error);
    } catch { if (active.current) setError(failure); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <span className="action-control"><button {...props} type="button" disabled={disabled || busy} aria-busy={busy} onClick={() => void run()}>{children}</button>
    {error && <span className="field-err" role="alert">{error}</span>}</span>;
}
