import { useEffect, useRef, useState } from 'react';
import type { DictationState, ShortcutPrefs, ShortcutStatus } from '../shared/dictation';
import { DEFAULT_SHORTCUTS, shortcutLabel } from '../shared/dictation';

import { shortcutFromEvent } from '../shared/shortcuts';
import { DEFAULT_MODELS, DICTATION_MODELS, POLISH_MODELS, type ModelPrefs } from '../shared/model-settings';

const empty: DictationState = { phase: 'idle', text: '', message: '', startedAt: null, level: 0, retryable: false };

export function DictationHUD() {
  const [state, setState] = useState(empty), [now, setNow] = useState(Date.now()), [actionError, setActionError] = useState('');
  useEffect(() => {
    document.documentElement.classList.add('dictation-surface');
    let changed = false, active = true;
    const off = window.earshot.onDictation(value => { changed = true; setState(value); setActionError(''); });
    void window.earshot.dictationSnapshot().then(value => { if (active && !changed) setState(value); });
    return () => { active = false; off(); document.documentElement.classList.remove('dictation-surface'); };
  }, []);
  useEffect(() => { if (state.phase !== 'listening') return; const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, [state.phase]);
  return <DictationPanel state={state} now={now} actionError={actionError} onActionError={setActionError} />;
}

export function DictationPanel({ state, now, actionError, onActionError }: { state: DictationState; now: number; actionError: string; onActionError: (message: string) => void }) {
  if (state.phase === 'idle') return null;
  return <main className={`dictation-hud phase-${state.phase}`}>
    <div className="dictation-status">
      <div className="dictation-signal" aria-hidden="true">{state.phase === 'listening'
        ? [0.5, .8, 1, .65, .9].map((height, i) => <i key={i} style={{ transform: `scaleY(${.18 + height * state.level})` }} />)
        : <span>{state.phase === 'success' ? '✓' : state.phase === 'error' || state.resultKind === 'delivery-failed' ? '!' : state.phase === 'result' ? '↳' : '···'}</span>}</div>
      <div className="grow"><strong role="status">{state.message}</strong>
        <p>{state.phase === 'listening' ? '松开结束 · Esc 取消' : state.phase === 'transcribing' ? (state.message === '正在填入' ? 'Esc 停止后续操作' : 'Esc 取消') : state.phase === 'preparing' ? '松开或 Esc 取消' : state.resultKind === 'delivery-canceled' ? '取消不会撤回已填入的文字。结果仍可复制。' : state.resultKind === 'delivery-unconfirmed' ? '已发送一次粘贴，无法确认是否填入。文字已保留。' : state.resultKind === 'save-failed' ? '本次未保存，可先复制到需要的位置' : state.resultKind === 'delivery-failed' ? '文字已保留，可复制后粘贴' : state.resultKind === 'preview' ? '复制后，到需要的位置粘贴' : state.phase === 'success' ? '文字已保留' : '语音输入'}</p></div>
      {state.phase === 'listening' && <span className="dictation-clock" aria-hidden="true">{Math.max(0, Math.floor((now - (state.startedAt ?? now)) / 1000))} 秒</span>}
      <button className="dictation-close" type="button" aria-label="关闭语音输入" onClick={() => void window.earshot.cancelDictation()}>×</button>
    </div>
    {state.text && state.phase === 'result' && <p className="dictation-result" tabIndex={0}>{state.text}</p>}
    {(state.phase === 'result' || state.phase === 'error') && <div className="dictation-actions">
      {state.text && <button type="button" onClick={async () => { const result = await window.earshot.copyDictation(); if (!result.ok) onActionError(result.error); }}>复制文字</button>}
      {state.retryable && <button type="button" onClick={async () => { const result = await window.earshot.retryDictation(); if (!result.ok) onActionError(result.error); }}>重试识别</button>}
      {!state.text && !state.retryable && <button type="button" onClick={() => void window.earshot.showLibrary()}>打开 Earshot</button>}
      <button type="button" onClick={() => void window.earshot.cancelDictation()}>关闭</button>
    </div>}
    {actionError && <p className="dictation-action-error" role="alert">{actionError}</p>}
  </main>;
}

export function DictationSettings({ status }: { status?: ShortcutStatus }) {
  const prefs = status?.prefs ?? DEFAULT_SHORTCUTS;
  const keyRequest = useRef(0);
  const [recordingKey, setRecordingKey] = useState<'meeting' | 'dictation' | null>(null);
  const [draft, setDraft] = useState(prefs), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => setDraft(prefs), [prefs.enabled, prefs.meeting, prefs.dictation, prefs.delivery, prefs.wechatCompatibility, prefs.models?.asr, prefs.models?.polish]);
  async function save(next: ShortcutPrefs) {
    if (busy) return; setBusy(true); setMessage('');
    try {
      const result = await window.earshot.saveShortcuts(next);
      if (!result.ok) { setMessage(result.error); setDraft(prefs); }
      else { setDraft(next); setMessage('已保存'); }
    } catch { setMessage('设置未保存，请重试'); setDraft(prefs); }
    finally { setBusy(false); }
  }
  useEffect(() => () => { keyRequest.current++; void window.earshot.setShortcutCapture(false); }, []);
  useEffect(() => { if (!recordingKey) return; const timer = setTimeout(() => { stopKeyCapture(); setMessage('快捷键未更改，点击键位可重新设置'); }, 28000); return () => clearTimeout(timer); }, [recordingKey]);
  function stopKeyCapture() { keyRequest.current++; setRecordingKey(null); void window.earshot.setShortcutCapture(false); }
  function keyControl(field: 'meeting' | 'dictation') {
    return <button type="button" className={`shortcut-key${recordingKey === field ? ' capturing' : ''}`} title="点击更改快捷键" disabled={busy || (field === 'dictation' && !draft.enabled)} aria-label={`${field === 'meeting' ? '录制快捷键' : '语音输入快捷键'}：${shortcutLabel(draft[field])}，点击更改`}
      onClick={async event => { const button = event.currentTarget, request = ++keyRequest.current; const result = await window.earshot.setShortcutCapture(true); if (request !== keyRequest.current || !button.isConnected || document.activeElement !== button) { void window.earshot.setShortcutCapture(false); return; } if (result.ok) { setRecordingKey(field); setMessage('按下组合键，Esc 取消'); } else setMessage(result.error); }}
      onBlur={stopKeyCapture} onKeyDown={event => {
        if (recordingKey !== field) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { stopKeyCapture(); setMessage(''); return; }
        if (['Meta', 'Alt', 'Control', 'Shift'].includes(event.key)) return;
        const value = shortcutFromEvent(event);
        if (!value) { setMessage('请按住 ⌘、⌃ 或 ⌥ 再选一个键，也可使用 F1–F20'); return; }
        setRecordingKey(null); void save({ ...draft, [field]: value }).finally(() => window.earshot.setShortcutCapture(false));
      }}>{recordingKey === field ? '请按组合键…' : shortcutLabel(draft[field])}</button>;
  }
  const models = draft.models ?? DEFAULT_MODELS;
  return <div className="dictation-settings">
    <section className="settings-section" aria-labelledby="shortcut-heading"><h3 id="shortcut-heading">快捷键</h3>
      <div className="set-card">
        <div className="set-row"><div>开始录制<p className="why">录制中再次按下，可回到当前录音。</p></div>{keyControl('meeting')}</div>
        <div className="set-row"><div>语音输入<p className="why">按住说话，松开转写。Esc 取消。</p></div>{keyControl('dictation')}</div>
      </div>
      <p className="settings-caption">点击键位即可更改。</p>
    </section>
    <section className="settings-section" aria-labelledby="dictation-heading"><h3 id="dictation-heading">语音输入</h3>
    <div className="set-card">
    <div className="set-row"><div>开启语音输入<p className="why">使用麦克风收音，转写自动保存在会话列表。</p></div>
      <button type="button" className={`knob${draft.enabled ? ' on' : ''}`} role="switch" aria-label="语音输入" aria-checked={draft.enabled} disabled={busy} onClick={() => void save({ ...draft, enabled: !draft.enabled })} /></div>
    <div className="set-row"><div>自动填入<p className="why">说完填入原来的位置，不自动发送。关闭后显示结果，手动复制。</p></div>
      <button type="button" className={`knob${draft.delivery === 'direct' ? ' on' : ''}`} role="switch" aria-label="自动填入" aria-checked={draft.delivery === 'direct'}
        disabled={busy || !draft.enabled} onClick={() => void save({ ...draft, delivery: draft.delivery === 'direct' ? 'preview' : 'direct' })} /></div>
    <div className="set-row"><div>语音识别模型<p className="why">按录音时长计费，{DICTATION_MODELS.find(model => model.id === models.asr)?.price}。</p></div>
      <select aria-label="语音识别模型" value={models.asr} disabled={busy || !draft.enabled} onChange={event => void save({ ...draft, models: { ...models, asr: event.target.value as ModelPrefs['asr'] } })}>
        {DICTATION_MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select></div>
    <div className="set-row"><div>文字整理<p className="why">调整标点、去除口头重复。会稍慢，原始转写会保留。</p></div>
      <select aria-label="文字整理" value={models.polish} disabled={busy || !draft.enabled} onChange={event => void save({ ...draft, models: { ...models, polish: event.target.value as ModelPrefs['polish'] } })}>
        {POLISH_MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select></div>
    </div>
    <p className="settings-caption">各应用统一通过临时剪贴板粘贴。位置变化时保留文字；无法确认时请检查输入框。粘贴后恢复原剪贴板，期间的新复制会保留。</p>
    <details className="settings-caption settings-note"><summary>费用说明</summary><p>语音识别按录音时长计费。开启文字整理会额外按文字用量计费。以上为参考价格，实际费用由你的百炼账户结算。</p></details>
    </section>
    {status && !status.holdAvailable && <p className="settings-feedback error" role="alert">语音输入暂不可用，请重新打开 Earshot 后再试。</p>}
    {(message || status?.error) && <p className={`settings-feedback${status?.error || (message && message !== '已保存' && !recordingKey) ? ' error' : ''}`} role="status">{message || status?.error}</p>}
  </div>;
}

export function DictationPermission({ status }: { status?: ShortcutStatus }) {
  return <div className="set-row"><div>辅助功能<p className="why">允许语音输入向其他 App 的输入框填写文字。</p></div>
    {status?.accessibility ? <span className="st ok">已允许</span> : <button type="button" className="btn ghost" onClick={() => void window.earshot.requestAccessibility()}>打开系统设置</button>}
  </div>;
}
