import { useEffect, useRef, useState } from 'react';
import type { ActionResult, PlaybackState } from '../shared/types';
import { formatClock } from './format';

export function PlaybackBar({ playback, blocked, onOpen }: {
  playback: PlaybackState; blocked: boolean; onOpen: (id: string) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const currentId = useRef(playback.sessionId); currentId.current = playback.sessionId;
  useEffect(() => { setDraft(null); setError(null); }, [playback.sessionId]);
  async function run(action: () => Promise<ActionResult>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    const id = playback.sessionId;
    try {
      const result = await action();
      if (!result.ok && currentId.current === id) setError(result.error);
    } catch { if (currentId.current === id) setError('无法回听，请重试'); }
    finally { pending.current = false; setBusy(false); setDraft(null); }
  }
  function seek() {
    if (draft === null) return;
    const positionSec = draft;
    void run(() => window.earshot.seekPlayback({ sessionId: playback.sessionId, positionSec }));
  }
  function skip(seconds: number) {
    const positionSec = Math.max(0, Math.min(playback.durationSec, playback.positionSec + seconds));
    void run(() => window.earshot.seekPlayback({ sessionId: playback.sessionId, positionSec }));
  }
  const loading = playback.status === 'loading';
  const playing = playback.status === 'playing';
  const failed = playback.status === 'error';
  return <section className="playback-bar" aria-label="回听控制">
    <div className="playback-row">
      <button type="button" className="btn playback-toggle" disabled={busy || loading || blocked}
        onClick={() => void run(() => playing ? window.earshot.pausePlayback(playback.sessionId)
          : window.earshot.playSession(playback.sessionId))}>
        {loading ? '载入中…' : failed ? '重新播放' : playing ? '暂停' : playback.status === 'ended' ? '从头播放' : '继续播放'}
      </button>
      <button type="button" className="playback-title" title={playback.title} onClick={() => onOpen(playback.sessionId)}>
        <span>正在回听</span><strong>{playback.title}</strong>
      </button>
      <button type="button" className="btn text" aria-label="后退 5 秒" disabled={busy || loading || failed || blocked}
        onClick={() => skip(-5)}>−5 秒</button>
      <div className="playback-seek">
        <input type="range" aria-label="播放位置" aria-valuetext={`${formatClock(draft ?? playback.positionSec)}，共 ${formatClock(playback.durationSec)}`}
          min={0} max={playback.durationSec} step={0.1} value={draft ?? playback.positionSec}
          disabled={busy || loading || failed || blocked}
          onChange={event => setDraft(Number(event.target.value))} onPointerUp={seek}
          onKeyUp={event => { if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) seek(); }}
          onBlur={seek} />
        <output>{formatClock(draft ?? playback.positionSec)} / {formatClock(playback.durationSec)}</output>
      </div>
      <button type="button" className="btn text" aria-label="前进 5 秒" disabled={busy || loading || failed || blocked}
        onClick={() => skip(5)}>+5 秒</button>
      <select aria-label="播放速度" value={playback.rate} disabled={busy || loading || failed || blocked}
        style={{ width: 'auto', minWidth: 70 }}
        onChange={event => { const rate = Number(event.target.value); void run(() => window.earshot.setPlaybackRate(rate)); }}>
        {[0.75, 1, 1.25, 1.5, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}
      </select>
      <button type="button" className="btn text" disabled={busy} onClick={() => void run(window.earshot.stopPlayback)}>结束回听</button>
    </div>
    {error || playback.error ? <p role="alert" className="playback-message">{error ?? playback.error}</p>
      : playback.warning ? <p role="status" className="playback-message">{playback.warning}</p> : null}
  </section>;
}
