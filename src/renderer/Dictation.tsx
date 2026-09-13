import { ActionButton } from './ActionButton';
import { useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../shared/types';
import type { DictationState, ShortcutPrefs, ShortcutStatus } from '../shared/dictation';
import { DEFAULT_SHORTCUTS, shortcutLabel } from '../shared/dictation';

import { ActivitySignal } from './ActivitySignal';
import { shortcutFromEvent } from '../shared/shortcuts';
import { DEFAULT_MODELS, DICTATION_MODELS, POLISH_MODELS, type ModelPrefs } from '../shared/model-settings';

const empty: DictationState = { phase: 'idle', text: '', message: '', startedAt: null, level: 0, retryable: false };

export function DictationHUD() {
  const [state, setState] = useState(empty), [now, setNow] = useState(Date.now()), [actionError, setActionError] = useState('');
  useEffect(() => {
    document.documentElement.classList.add('dictation-surface');
    let changed = false, active = true;
    const off = window.earshot.onDictation(value => { changed = true; setState(value); setActionError(''); });
    void window.earshot.dictationSnapshot().then(value => { if (active && !changed) setState(value); }).catch(() => { if (active && !changed) setState({ ...empty, phase: 'error', message: '无法读取语音输入状态，请重新打开 Earshot' }); });
    return () => { active = false; off(); document.documentElement.classList.remove('dictation-surface'); };
  }, []);
  useEffect(() => { if (state.phase !== 'listening') return; const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, [state.phase]);
  return <DictationPanel state={state} now={now} actionError={actionError} onActionError={setActionError} />;
}

export function DictationPanel({ state, now, actionError, onActionError }: { state: DictationState; now: number; actionError: string; onActionError: (message: string) => void }) {
  const actionPending = useRef(false);
  const cancelPending = useRef(false), attempt = useRef(0);
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);
  useEffect(() => () => { attempt.current++; }, []);
  const elapsed = Math.max(0, Math.floor((now - (state.startedAt ?? now)) / 1000));
  useEffect(() => setFeedback(''), [state.phase, state.startedAt]);
  async function act(action: () => Promise<ActionResult | void>, success = '') {
    if (actionPending.current) return;
    const request = ++attempt.current;
    actionPending.current = true; setBusy(true); onActionError(''); setFeedback('');
    try { const result = await action(); if (request === attempt.current) { if (result && !result.ok) onActionError(result.error); else setFeedback(success); } }
    catch { if (request === attempt.current) onActionError('操作未完成，请重试'); }
    finally { if (request === attempt.current) { actionPending.current = false; setBusy(false); } }
  }
  async function cancel() {
    if (cancelPending.current) return;
    const request = ++attempt.current;
    cancelPending.current = true; setCancelBusy(true); onActionError('');
    try { await window.earshot.cancelDictation(); }
    catch { if (request === attempt.current) onActionError('未能关闭语音输入，请重试'); }
    finally { if (request === attempt.current) { cancelPending.current = false; actionPending.current = false; setCancelBusy(false); setBusy(false); } }
  }
  if (state.phase === 'idle') return null;
  return <main className={`dictation-hud phase-${state.phase}`}>
    <div className="dictation-status">
      <div className="dictation-signal" aria-hidden="true">{state.phase === 'listening'
        ? [0.5, .8, 1, .65, .9].map((height, i) => <i key={i} style={{ transform: `scaleY(${.18 + height * state.level})` }} />)
        : state.phase === 'preparing' || state.phase === 'transcribing' ? <ActivitySignal /> : <span>{state.phase === 'success' ? '✓' : state.phase === 'error' || state.resultKind === 'delivery-failed' ? '!' : state.phase === 'result' ? '↳' : '···'}</span>}</div>
      <div className="grow"><strong role="status">{state.message}</strong>
        <p role={feedback ? 'status' : undefined}>{feedback || (state.phase === 'listening' ? elapsed >= 50 ? `还可说 ${Math.max(0, 60 - elapsed)} 秒 · 松开结束` : '松开结束 · Esc 取消'  : state.phase === 'transcribing' ? (state.message === '正在填入' ? 'Esc 停止后续操作' : 'Esc 取消') : state.phase === 'preparing' ? '松开或 Esc 取消' : state.resultKind === 'delivery-canceled' ? '取消不会撤回已填入的文字。结果仍可复制。' : state.resultKind === 'delivery-unconfirmed' ? '已发送一次粘贴，无法确认是否填入。文字已保留。' : state.resultKind === 'save-failed' ? '本次未保存，可先复制到需要的位置' : state.resultKind === 'delivery-failed' ? '文字已保留，可复制后粘贴' : state.resultKind === 'preview' ? '复制后，到需要的位置粘贴' : state.phase === 'success' ? '文字已保留' : '语音输入')}</p></div>
      {state.phase === 'listening' && <span className="dictation-clock" aria-hidden="true">{elapsed} / 60 秒</span>}
      <button className="dictation-close" type="button" aria-label="关闭语音输入" disabled={cancelBusy} onClick={() => void cancel()}>×</button>
    </div>
    {state.text && state.phase === 'result' && <p className="dictation-result" tabIndex={0}>{state.text}</p>}
    {(state.phase === 'result' || state.phase === 'error') && <div className="dictation-actions">
      {state.text && <button type="button" disabled={busy || cancelBusy} onClick={() => void act(window.earshot.copyDictation, "已复制，可粘贴到需要的位置")}>复制文字</button>}
      {state.retryable && <button type="button" disabled={busy || cancelBusy} onClick={() => void act(window.earshot.retryDictation)}>重试识别</button>}
      {!state.text && !state.retryable && <button type="button" disabled={busy || cancelBusy} onClick={() => void act(window.earshot.showLibrary)}>打开 Earshot</button>}
      <button type="button" disabled={cancelBusy} onClick={() => void cancel()}>关闭</button>
    </div>}
    {actionError && <p className="dictation-action-error" role="alert">{actionError}</p>}
  </main>;
}

export function DictationSettings({ status }: { status?: ShortcutStatus }) {
  const prefs = status?.prefs ?? DEFAULT_SHORTCUTS;
  const keyRequest = useRef(0), saving = useRef(false);
  const [recordingKey, setRecordingKey] = useState<'meeting' | 'dictation' | null>(null);
  const [draft, setDraft] = useState(prefs), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => setDraft(prefs), [prefs.enabled, prefs.meeting, prefs.dictation, prefs.delivery, prefs.wechatCompatibility, prefs.models?.asr, prefs.models?.polish]);
  async function save(next: ShortcutPrefs) {
    if (saving.current) return; saving.current = true; setBusy(true); setMessage('');
    try {
      const result = await window.earshot.saveShortcuts(next);
      if (!result.ok) { setMessage(result.error); setDraft(prefs); }
      else { setDraft(next); setMessage('已保存'); }
    } catch { setMessage('设置未保存，请重试'); setDraft(prefs); }
    finally { saving.current = false; setBusy(false); }
  }
  useEffect(() => () => { keyRequest.current++; void window.earshot.setShortcutCapture(false).catch(() => undefined); }, []);
  useEffect(() => { if (!recordingKey) return; const timer = setTimeout(() => { stopKeyCapture(); setMessage(''); }, 28000); return () => clearTimeout(timer); }, [recordingKey]);
  function stopKeyCapture() { keyRequest.current++; setRecordingKey(null); setMessage(''); void window.earshot.setShortcutCapture(false).catch(() => setMessage('快捷键未能恢复，请重新打开 Earshot')); }
  function keyControl(field: 'meeting' | 'dictation') {
    return <button type="button" className={`shortcut-key${recordingKey === field ? ' capturing' : ''}`} title="点击更改快捷键" disabled={busy || (field === 'dictation' && !draft.enabled)} aria-label={`${field === 'meeting' ? '录制快捷键' : '语音输入快捷键'}：${shortcutLabel(draft[field])}，点击更改`}
      onClick={async event => { const button = event.currentTarget, request = ++keyRequest.current; const result = await window.earshot.setShortcutCapture(true).catch(() => ({ ok: false as const, error: '无法开始设置快捷键，请重试' })); if (request !== keyRequest.current || !button.isConnected || document.activeElement !== button) { void window.earshot.setShortcutCapture(false).catch(() => undefined); return; } if (result.ok) { setRecordingKey(field); setMessage('按下组合键，Esc 取消'); } else setMessage(result.error); }}
      onBlur={stopKeyCapture} onKeyDown={event => {
        if (recordingKey !== field) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { stopKeyCapture(); setMessage(''); return; }
        if (['Meta', 'Alt', 'Control', 'Shift'].includes(event.key)) return;
        const value = shortcutFromEvent(event);
        if (!value) { setMessage('请按住 ⌘、⌃ 或 ⌥ 再选一个键，也可使用 F1–F20'); return; }
        setRecordingKey(null); void save({ ...draft, [field]: value }).finally(() => { void window.earshot.setShortcutCapture(false).catch(() => setMessage('快捷键未能恢复，请重新打开 Earshot')); });
      }}>{recordingKey === field ? '请按组合键…' : shortcutLabel(draft[field])}</button>;
  }
  const models = draft.models ?? DEFAULT_MODELS;
  return <div className="dictation-settings">
    <section className="settings-section" aria-labelledby="shortcut-heading"><h3 id="shortcut-heading">快捷键</h3>
      <div className="set-card">
        <div className="set-row"><div>开始录制<p className="why">录制中再次按下，回到当前录音。</p></div>{keyControl('meeting')}</div>
        <div className="set-row"><div>语音输入<p className="why">按住说话，松开转写；单次最长 60 秒，Esc 取消。</p></div>{keyControl('dictation')}</div>
      </div>
      <p className="settings-caption">点击键位即可更改。</p>
    </section>
    <section className="settings-section" aria-labelledby="dictation-heading"><h3 id="dictation-heading">语音输入</h3>
    <div className="set-card">
    <div className="set-row"><div>开启语音输入<p className="why">用麦克风说话，文字自动保存到会话。</p></div>
      <button type="button" className={`knob${draft.enabled ? ' on' : ''}`} role="switch" aria-label="语音输入" aria-checked={draft.enabled} disabled={busy} onClick={() => void save({ ...draft, enabled: !draft.enabled })} /></div>
    <div className="set-row"><div>自动填入<p className="why">说完填入原输入框，不会发送。关闭后可手动复制。</p></div>
      <button type="button" className={`knob${draft.delivery === 'direct' ? ' on' : ''}`} role="switch" aria-label="自动填入" aria-checked={draft.delivery === 'direct'}
        disabled={busy || !draft.enabled} onClick={() => void save({ ...draft, delivery: draft.delivery === 'direct' ? 'preview' : 'direct' })} /></div>
    <div className="set-row"><div>语音识别模型<p className="why">按录音时长计费，{DICTATION_MODELS.find(model => model.id === models.asr)?.price}。</p></div>
      <select aria-label="语音识别模型" value={models.asr} disabled={busy || !draft.enabled} onChange={event => void save({ ...draft, models: { ...models, asr: event.target.value as ModelPrefs['asr'] } })}>
        {DICTATION_MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select></div>
    <div className="set-row"><div>文字整理<p className="why">整理标点和口头重复，保留原始转写。开启后会稍慢。</p></div>
      <select aria-label="文字整理" value={models.polish} disabled={busy || !draft.enabled} onChange={event => void save({ ...draft, models: { ...models, polish: event.target.value as ModelPrefs['polish'] } })}>
        {POLISH_MODELS.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select></div>
    </div>
    <details className="settings-caption settings-note"><summary>自动填入与费用说明</summary>
      <p>自动填入使用临时剪贴板粘贴，完成后恢复原剪贴板，期间新复制的内容会保留。输入位置变化时会保留文字供复制；提示未确认时，请检查输入框。</p>
      <p>语音识别按录音时长计费，文字整理另按文字用量计费。所示价格仅供参考，实际费用以百炼账单为准。</p>
    </details>
    </section>
    {status && !status.holdAvailable && <p className="settings-feedback error" role="alert">语音输入暂不可用，请重新打开 Earshot 后再试。</p>}
    {(message || status?.error) && <p className={`settings-feedback${status?.error || (message && message !== '已保存' && !recordingKey) ? ' error' : ''}`} role="status">{status?.error || message}</p>}
  </div>;
}

export function DictationPermission({ status }: { status?: ShortcutStatus }) {
  return <div className="set-row"><div>辅助功能<p className="why">允许语音输入向其他 App 的输入框填写文字。</p></div>
    {status?.accessibility ? <span className="st ok">已允许</span> : <ActionButton className="btn ghost" action={window.earshot.requestAccessibility} failure="未能打开系统设置，请重试">打开系统设置</ActionButton>}
  </div>;
}
