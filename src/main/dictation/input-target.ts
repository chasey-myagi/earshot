import type { DeliveryResult, InputTarget } from './controller';
import type { PasteClipboard } from './clipboard';

export type Selection = { location: number; length: number };
export type EditableSnapshot = { value: string; range: Selection };
export type TargetCheck = { sameContext: boolean; secure: boolean; keysReleased: boolean; editable: EditableSnapshot | null; reason?: string };
export type PasteTargetPort = {
  prepare: () => void;
  read: () => TargetCheck;
  paste: (allowed: () => boolean) => 'not-posted' | 'posted' | 'uncertain';
  release: () => void;
};

export function validSelection(value: string, range: Selection): boolean {
  return Number.isSafeInteger(range.location) && Number.isSafeInteger(range.length)
    && range.location >= 0 && range.length >= 0 && range.location + range.length <= value.length;
}
const same = (a: EditableSnapshot, b: EditableSnapshot | null) => !!b && a.value === b.value
  && a.range.location === b.range.location && a.range.length === b.range.length;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** AX supplies evidence when available. Its absence is not a gate on recording or
 * a blanket ban on paste. All targets use exactly one clipboard transaction. */
export function createPasteTarget(port: PasteTargetPort, clipboard: PasteClipboard, timing = { releaseMs: 600, verifyMs: 600, verifiedRestoreMs: 500, opaqueRestoreMs: 1000 }): InputTarget {
  let before: EditableSnapshot | null = null, prepared = false, released = false, attempted = false;
  let unavailable: string | undefined;
  function prepare() {
    if (prepared || released) return;
    prepared = true;
    try {
      port.prepare(); const state = port.read();
      if (!state.sameContext || state.secure) unavailable = state.reason ?? '输入位置已变化，请复制文字';
      before = state.editable && validSelection(state.editable.value, state.editable.range) ? state.editable : null;
    } catch { unavailable = '无法确认输入位置，请复制文字'; }
  }
  return {
    prepare,
    async insert(text, signal) {
      const stopped = () => released || signal.aborted;
      const notPosted = (reason: string): DeliveryResult => ({ kind: 'not-posted', reason });
      if (stopped() || attempted) return notPosted('本次输入已结束，请复制文字');
      attempted = true; prepare();
      if (unavailable) return notPosted(unavailable);
      if (!text || text.length > 65_536 || text.includes('\0') || !wellFormedUtf16(text)) return notPosted('这段文字无法自动填入，请复制文字');
      let id: string | undefined, posted = false, postedAt = 0, verified = false;
      let result: DeliveryResult = notPosted('尚未填入，请复制文字');
      function allowed(): boolean {
        if (stopped()) return false;
        const state = port.read();
        return state.sameContext && !state.secure && state.keysReleased && (!before || same(before, state.editable));
      }
      try {
        const deadline = Date.now() + timing.releaseMs;
        while (!stopped()) {
          const state = port.read();
          if (!state.sameContext || state.secure) return notPosted(state.reason ?? '你已切换输入位置，请复制文字');
          if (before && !same(before, state.editable)) return notPosted('原文或光标位置已变化，请复制文字');
          if (state.keysReleased) break;
          if (Date.now() >= deadline) return notPosted('快捷键尚未完全松开，请复制文字');
          await sleep(20);
        }
        if (!allowed()) return notPosted('输入位置已变化或本次已取消，请复制文字');
        id = await clipboard.claim(text, signal);
        if (!await clipboard.owned(id) || !allowed()) result = notPosted('输入位置或剪贴板已变化，请复制文字');
        else {
          // Exceptions around dispatch are unconfirmed, never retried.
          posted = true; postedAt = Date.now();
          const status = port.paste(allowed);
          posted = status !== 'not-posted';
          if (!posted) result = notPosted('尚未填入：输入条件已变化，请复制文字');
          else {
            result = { kind: 'posted-unconfirmed' };
            if (status === 'posted' && before) {
              const expected = before.value.slice(0, before.range.location) + text + before.value.slice(before.range.location + before.range.length);
              const caret = before.range.location + text.length, deadline = Date.now() + timing.verifyMs;
              while (!stopped() && Date.now() < deadline) {
                await sleep(20);
                if (stopped()) break;
                const state = port.read();
                if (!state.sameContext || state.secure) break;
                const after = state.editable;
                if (after?.value === expected && after.range.location === caret && after.range.length === 0) { verified = true; break; }
                if (!after || (after.value !== before.value && after.value !== expected)) break;
              }
            }
            result = verified ? { kind: 'verified' } : { kind: 'posted-unconfirmed' };
          }
        }
      } catch (error) {
        const warning = error && typeof error === 'object' && 'warning' in error && typeof error.warning === 'string' ? error.warning : undefined;
        result = { ...(posted ? { kind: 'posted-unconfirmed' as const } : notPosted(error instanceof Error ? error.message : '剪贴板暂不可用，请复制文字')), ...(warning ? { warning } : {}) };
      } finally {
        if (id) {
          // A canceled HUD cannot prove the recipient has consumed the clipboard.
          if (posted) await sleep(Math.max(0, (verified ? timing.verifiedRestoreMs : timing.opaqueRestoreMs) - (Date.now() - postedAt)));
          try { await clipboard.finish(id); }
          catch { result = { ...result, warning: '原剪贴板未能恢复，识别文字已保留' }; }
        }
      }
      return result;
    },
    release() { if (!released) { released = true; before = null; port.release(); } },
  };
}

export function wellFormedUtf16(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { const next = text.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
