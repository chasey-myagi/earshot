import { randomUUID } from 'node:crypto';
import type { DictationState } from '../../shared/dictation';
import type { ActionResult } from '../../shared/types';

export type InputTarget = { insert: (text: string) => boolean; release: () => void };
const idle = (): DictationState => ({ phase: 'idle', text: '', message: '', startedAt: null, level: 0, retryable: false });

export function createDictationController(opts: {
  preflight: () => string | null;
  target: () => InputTarget | null;
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
  let capture: { stop: () => Promise<void> } | null = null;
  let opening: Promise<unknown> | null = null;
  let chunks: Buffer[] = [], length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, hide: ReturnType<typeof setTimeout> | undefined;
  let beginning = false, recordId = '', lastLevelAt = 0;
  let stream: ReturnType<NonNullable<typeof opts.stream>> | null = null;
  let closing: Promise<void> | null = null;
  const maxBytes = 16000 * 2 * ((opts.maxMs ?? 60000) / 1000);
  function publish(patch: Partial<DictationState>) { state = { ...state, ...patch }; opts.changed({ ...state }); }
  function releaseTarget() { target?.release(); target = null; }
  function eraseAudio() { for (const chunk of chunks) chunk.fill(0); chunks = []; length = 0; }
  function busy() { return Boolean(beginning || opening || closing || ['preparing', 'listening', 'transcribing'].includes(state.phase)); }
  function fail(message: string, retryable = false) { publish({ phase: 'error', message, level: 0, retryable }); }

  async function cancel(): Promise<void> {
    generation++; clearTimeout(timer); clearTimeout(hide); abort?.abort(); stream = null;
    const active = capture; capture = null;
    // Publish immediately, but keep ownership until delayed capture startup has disposed itself.
    state = idle(); opts.changed({ ...state }); releaseTarget(); eraseAudio();
    const drain = (async () => { try { await active?.stop(); await opening; } catch { /* teardown still owns capture */ } })();
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
      if (opts.complete) text = await opts.complete(text, { id: recordId, startedAt: state.startedAt ?? Date.now(), durationSec: length / 32000, signal,
        progress: message => { if (generation === token && !signal.aborted) publish({ message }); } });
      if (generation !== token || signal.aborted) return;
      eraseAudio();
      publish({ text, retryable: false });
      if (opts.preview()) { publish({ phase: 'result', message: '文字已准备好' }); return; }
      insert();
    } catch (error) {
      stream = null;
      if (generation === token && !signal.aborted) fail(error instanceof Error ? error.message : '识别失败，请重试', true);
    } finally { pcm.fill(0); }
  }

  function insert(): ActionResult {
    if (!state.text || !['result', 'transcribing'].includes(state.phase)) return { ok: false, error: '没有可输入的文字' };
    let inserted = false;
    try { inserted = target?.insert(state.text) ?? false; } catch { /* preserve text for copy */ }
    releaseTarget();
    if (!inserted) {
      publish({ phase: 'result', message: '输入位置已变化或无法写入，请复制文字' });
      return { ok: false, error: state.message };
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
    const blocked = opts.preflight();
    if (blocked) { beginning = false; fail(blocked); return { ok: false, error: blocked }; }
    const token = ++generation;
    abort = new AbortController(); recordId = randomUUID(); lastLevelAt = 0;
    try { target = opts.target(); } catch { target = null; }
    publish({ phase: 'preparing', message: '正在打开麦克风…', text: '', startedAt: null });
    const operation = (async () => {
      try {
        stream = opts.stream?.(abort!.signal) ?? null;
        const captured = await opts.capture({ signal: abort!.signal, failed: () => { if (generation !== token) return; const next = generation + 1; void cancel().then(() => { if (generation === next) fail('麦克风已断开，请重新尝试'); }); }, pcm: bytes => {
          if (generation !== token || state.phase !== 'listening') return;
          const remaining = Math.max(0, maxBytes - length);
          const copy = Buffer.from(bytes.subarray(0, remaining - remaining % 2));
          if (!copy.length) { void end(); return; }
          chunks.push(copy); length += copy.length;
          stream?.send(copy);
          let energy = 0;
          for (let i = 0; i < copy.length; i += 2) energy += (copy.readInt16LE(i) / 32768) ** 2;
          if (Date.now() - lastLevelAt >= 50) { lastLevelAt = Date.now(); publish({ level: Math.min(1, Math.sqrt(energy / (copy.length / 2)) * 5) }); }
          if (length >= maxBytes) void end();
        } });
        if (generation !== token) { await captured.stop(); return; }
        capture = captured;
        publish({ phase: 'listening', startedAt: Date.now(), message: '正在聆听' });
        timer = setTimeout(() => { void end(); }, opts.maxMs ?? 60000);
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
