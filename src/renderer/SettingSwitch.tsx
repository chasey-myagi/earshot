import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ActionResult } from '../shared/types';

/** Keep the persisted value visible until the main process acknowledges a change. */
export function SettingSwitch({ label, description, enabled, save }: {
  label: string; description: ReactNode; enabled: boolean; save: (on: boolean) => Promise<ActionResult | void>;
}) {
  const id = useId(), pending = useRef(false), active = useRef(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function toggle() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { const result = await save(!enabled); if (active.current && result && !result.ok) setError(result.error); }
    catch { if (active.current) setError('设置未保存，请重试'); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <div className="set-row"><div>{label}<p className="why" id={id}>{description}</p>
    {error && <p className="field-err" role="alert">{error}</p>}</div>
    <button type="button" className={`knob${enabled ? ' on' : ''}`} role="switch" aria-label={label} aria-describedby={id}
      aria-checked={enabled} aria-busy={busy} disabled={busy} onClick={() => void toggle()} />
  </div>;
}
