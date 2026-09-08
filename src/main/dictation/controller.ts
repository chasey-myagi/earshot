import { randomUUID } from 'node:crypto';
import type { DictationState } from '../../shared/dictation';
import type { ActionResult } from '../../shared/types';

export type DeliveryResult = ({ kind: 'not-posted'; reason: string } | { kind: 'posted-unconfirmed' } | { kind: 'verified' }) & { warning?: string };
export type InputTarget = { screenPoint?: { x: number; y: number }; prepare?: () => void; insert: (text: string, signal: AbortSignal) => DeliveryResult | Promise<DeliveryResult>; release: () => void };
const idle = (): DictationState => ({ phase: 'idle', text: '', message: '', startedAt: null, level: 0, retryable: false });

export function createDictationController(opts: {
  preflight: () => string | null;
  target: () => InputTarget | null;
  targetFailure?: () => string | null;
  preview: () => boolean;
  capture: (input: { signal: AbortSignal; pcm: (bytes: Buffer) => void; failed: () => void }) => Promise<{ stop: () => Promise<void> }>;
  transcribe: (pcm: Buffer, signal: AbortSignal) => Promise<string>;
  stream?: (signal: AbortSignal) => { send: (bytes: Buffer) => void; finish: () => Promise<string> };
  complete?: (text: string, input: { id: string; startedAt: number; durationSec: number; signal: AbortSignal; progress: (message: string) => void }) => Promise<string>;
  changed: (state: DictationState) => void;
  maxMs?: number;
}) {
  let state = idle(), generation = 0;
  let target: InputTarget | null = null, abort: AbortController | null = null;
  let targetFailure: string | null = null;
  let capture: { stop: () => Promise<void> } | null = null;
  let opening: Promise<unknown> | null = null;
  let chunks: Buffer[] = [], length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, hide: ReturnType<typeof setTimeout> | undefined;
  let retryExpiry: ReturnType<typeof setTimeout> | undefined, targetPreparation: ReturnType<typeof setTimeout> | undefined;
  let delivering = false;
  let delivery: Promise<DeliveryResult> | null = null;
  let beginning = false, recordId = '', lastLevelAt = 0;
  let stream: ReturnType<NonNullable<typeof opts.stream>> | null = null;
  let closing: Promise<void> | null = null;
  const maxBytes = 16000 * 2 * ((opts.maxMs ?? 60000) / 1000);
  function publish(patch: Partial<DictationState>) { state = { ...state, ...patch }; opts.changed({ ...state }); }
  function releaseTarget() { target?.release(); target = null; }
  function eraseAudio() { for (const chunk of chunks) chunk.fill(0); chunks = []; length = 0; }
  function busy() { return Boolean(delivering || beginning || opening || closing || ['preparing', 'listening', 'transcribing'].includes(state.phase)); }
  function fail(message: string, retryable = false) { publish({ phase: 'error', message, level: 0, retryable }); }

  async function cancel(notify = false): Promise<void> {
    // Repeated user cancellation shares cleanup. Silent disposal (quit/lock/new
    // session) invalidates an earlier user-facing completion without racing it.
    if (closing) { if (!notify) generation++; return closing; }
    const token = ++generation, text = state.text, activeDelivery = delivery;
    clearTimeout(timer); clearTimeout(hide); clearTimeout(retryExpiry); clearTimeout(targetPreparation); abort?.abort(); stream = null;
    const active = capture; capture = null;
    state = idle(); opts.changed({ ...state }); releaseTarget(); eraseAudio();
    const drain = (async () => {
      try { await active?.stop(); await opening; } catch { /* teardown still owns capture */ }
      let outcome: DeliveryResult | undefined;
      if (activeDelivery) {
        try { outcome = await activeDelivery; } catch { outcome = { kind: 'posted-unconfirmed' }; }
      }
      if (!notify || token !== generation || !outcome) return;
      const warning = outcome.warning ? `；${outcome.warning}` : '';
      if (outcome.kind !== 'not-posted') {
        publish({ phase: 'result', resultKind: 'delivery-canceled', text,
          message: (outcome.kind === 'verified' ? '文字已填入，取消不会撤回' : '已停止后续操作，请检查输入框') + warning });
      } else if (outcome.warning) {
        publish({ phase: 'result', resultKind: 'delivery-failed', text, message: '已取消输入' + warning });
      }
    })();
    closing = drain;
    await drain;
    if (closing === drain) closing = null;
  }

  async function recognize(): Promise<void> {
    const token = generation;
    if (!stream) abort = new AbortController();
    const signal = abort!.signal;
    publish({ phase: 'transcribing', level: 0, message: '正在转成文字…', retryable: false });
    const pcm = Buffer.concat(chunks, length);
    try {
      let text = (await (stream ? stream.finish() : opts.transcribe(pcm, signal))).trim();
      stream = null;
      if (generation !== token || signal.aborted) return;
      if (!text) { eraseAudio(); releaseTarget(); fail('没有听清，请按住快捷键重新说一次'); return; }
      if (opts.complete) {
        try { text = await opts.complete(text, { id: recordId, startedAt: state.startedAt ?? Date.now(), durationSec: length / 32000, signal,
          progress: message => { if (generation === token && !signal.aborted) publish({ message }); } }); }
        catch {
          if (generation === token && !signal.aborted) {
            eraseAudio(); releaseTarget(); publish({ phase: 'result', resultKind: 'save-failed', text, message: '识别文字未能保存，可先复制', retryable: false });
          }
          return;
        }
      }
      if (generation !== token || signal.aborted) return;
      eraseAudio();
      clearTimeout(retryExpiry);
      if (opts.preview()) { releaseTarget(); publish({ text, retryable: false, phase: 'result', resultKind: 'preview', message: '识别完成' }); return; }
      // Direct delivery must not flash an expanded preview before insertion.
      state = { ...state, text, retryable: false };
      await insert();
    } catch (error) {
      stream = null;
      if (generation === token && !signal.aborted) {
        fail(error instanceof Error ? error.message : '识别失败，请重试', true);
        clearTimeout(retryExpiry);
        retryExpiry = setTimeout(() => { if (generation === token && state.phase === 'error') { eraseAudio(); releaseTarget(); fail('本次录音已过期，请按住快捷键重新说一次'); } }, 5 * 60_000);
        retryExpiry.unref?.();
      }
    } finally { pcm.fill(0); }
  }

  async function insert(): Promise<ActionResult> {
    if (delivering) return { ok: false, error: '正在确认输入结果' };
    if (state.phase === 'result') return { ok: false, error: '文字已保留，请检查输入框后按需复制' };
    if (!state.text || state.phase !== 'transcribing') return { ok: false, error: '没有可输入的文字' };
    const token = generation, activeTarget = target;
    delivering = true;
    publish({ message: '正在填入' });
    let result: DeliveryResult = { kind: 'not-posted', reason: targetFailure ?? '当前没有可用的输入位置，请复制文字' };
    try {
      if (activeTarget) {
        delivery = Promise.resolve(activeTarget.insert(state.text, abort!.signal));
        result = await delivery;
      }
    }
    catch { result = { kind: 'posted-unconfirmed' }; }
    finally { delivering = false; delivery = null; }
    if (generation !== token) return { ok: false, error: '已取消' };
    releaseTarget();
    if (result.kind === 'not-posted') {
      publish({ phase: 'result', resultKind: 'delivery-failed', message: result.reason + (result.warning ? `；${result.warning}` : '') });
      return { ok: false, error: state.message };
    }
    if (result.kind !== 'verified') {
      publish({ phase: 'result', resultKind: 'delivery-unconfirmed', retryable: false, message: '请检查输入框' + (result.warning ? `；${result.warning}` : '') });
      return { ok: true };
    }
    if (result.warning) {
      publish({ phase: 'result', resultKind: 'clipboard-warning', retryable: false, message: `已填入；${result.warning}` });
      return { ok: true };
    }
    publish({ phase: 'success', message: '已填入输入框', text: '' });
    hide = setTimeout(() => { void cancel(); }, 1200);
    return { ok: true };
  }

  async function end(): Promise<void> {
    if (state.phase === 'preparing' || (beginning && state.phase === 'idle')) { await cancel(); return; }
    if (state.phase !== 'listening') return;
    clearTimeout(timer);
    const token = generation, active = capture; capture = null;
    publish({ phase: 'transcribing', level: 0, message: '正在转成文字…' });
    try { await active?.stop(); }
    catch { if (generation === token) { eraseAudio(); releaseTarget(); fail('麦克风没有正常停止，请重新尝试'); } return; }
    if (generation !== token) return;
    if (length < 16000 * 2 * .2) { abort?.abort(); stream = null; eraseAudio(); releaseTarget(); fail('按住快捷键说完一句话，再松开'); return; }
    await recognize();
  }

  async function begin(): Promise<ActionResult> {
    if (busy()) return { ok: false, error: '语音输入正在进行' };
    beginning = true;
    const cleared = cancel();
    const request = generation;
    await cleared;
    if (request !== generation) { beginning = false; return { ok: false, error: '已取消' }; }
    const token = ++generation;
    abort = new AbortController(); recordId = randomUUID(); lastLevelAt = 0;
    try { target = opts.target(); } catch { target = null; }
    targetFailure = target ? null : opts.targetFailure?.() ?? null;
    publish({ phase: 'preparing', message: '正在准备麦克风', text: '', startedAt: null });
    const blocked = opts.preflight();
    if (blocked) { beginning = false; releaseTarget(); fail(blocked); return { ok: false, error: blocked }; }
    // IPC/paint is enqueued before the first cross-process AX request. Production
    // captureTarget only captures the foreground PID/window/screen synchronously.
    targetPreparation = setTimeout(() => { if (generation === token) { try { target?.prepare?.(); } catch { /* delivery will retain the result */ } } }, 0);
    const operation = (async () => {
      try {
        stream = opts.stream?.(abort!.signal) ?? null;
        const captured = await opts.capture({ signal: abort!.signal, failed: () => { if (generation !== token) return; const next = generation + 1; void cancel().then(() => { if (generation === next) fail('麦克风已断开，请重新尝试'); }); }, pcm: bytes => {
          if (generation !== token || !['preparing', 'listening'].includes(state.phase)) return;
          const remaining = Math.max(0, maxBytes - length);
          const copy = Buffer.from(bytes.subarray(0, remaining - remaining % 2));
          if (!copy.length) { if (state.phase === 'listening') void end(); return; }
          chunks.push(copy); length += copy.length;
          stream?.send(copy);
          let energy = 0;
          for (let i = 0; i < copy.length; i += 2) energy += (copy.readInt16LE(i) / 32768) ** 2;
          if (Date.now() - lastLevelAt >= 50) { lastLevelAt = Date.now(); publish({ level: Math.min(1, Math.sqrt(energy / (copy.length / 2)) * 5) }); }
          if (length >= maxBytes && state.phase === 'listening') void end();
        } });
        if (generation !== token) { await captured.stop(); return; }
        capture = captured;
        publish({ phase: 'listening', startedAt: Date.now(), message: '正在聆听' });
        timer = setTimeout(() => { void end(); }, opts.maxMs ?? 60000);
        if (length >= maxBytes) void end();
      } catch {
        if (generation === token) { abort?.abort(); stream = null; eraseAudio(); releaseTarget(); fail('无法打开麦克风，请检查麦克风权限'); }
      }
    })();
    opening = operation;
    await operation;
    if (opening === operation) opening = null;
    beginning = false;
    return state.phase === 'error' ? { ok: false, error: state.message } : { ok: true };
  }

  return {
    begin, end, cancel, insert, busy,
    sessionId: () => recordId,
    explain: (message: string) => { if (!busy()) fail(message); },
    snapshot: () => ({ ...state }),
    retry: async (): Promise<ActionResult> => {
      if (!state.retryable || busy() || !length) return { ok: false, error: '没有可重试的录音' };
      const blocked = opts.preflight(); if (blocked) return { ok: false, error: blocked };
      await recognize(); return { ok: true };
    },
  };
}
