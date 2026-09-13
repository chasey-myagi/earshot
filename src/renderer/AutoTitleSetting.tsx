import { useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../shared/types';

export function AutoTitleSetting({ enabled, save }: { enabled: boolean; save: (on: boolean) => Promise<ActionResult> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function toggle() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await save(!enabled);
      if (mounted.current && !result.ok) setError(result.error);
    } catch { if (mounted.current) setError('设置未保存，请重试'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="set-row auto-title-setting">
    <div>自动生成录音标题<p className="why" id="auto-title-description">转写完成后，用千问为新录音提炼简短标题。</p>
      <details className="settings-caption settings-note auto-title-note"><summary>生成规则与费用</summary>
        <p>录音至少 1 分钟，转写至少 200 个文字或数字。每场只尝试一次，手动名称会保留。</p>
        <p>使用 Qwen Flash，将最多 6,000 字转写发送到百炼，按 Token 计费。生成失败时保留原名。</p>
      </details>
      {error && <p className="field-err" role="alert">{error}</p>}
    </div>
    <button type="button" className={`knob${enabled ? ' on' : ''}`} role="switch" aria-checked={enabled}
      aria-label="自动生成录音标题" aria-describedby="auto-title-description" disabled={busy} aria-busy={busy} onClick={() => void toggle()} />
  </div>;
}
