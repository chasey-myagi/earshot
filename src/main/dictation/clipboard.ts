import { randomUUID } from 'node:crypto';
import { erasePasteboard, PASTE_MARKER, PasteboardWriteError, type PasteboardItem, type PasteboardSnapshot } from './macos-pasteboard';

export class ClipboardRestoreError extends Error {
  readonly warning = '原剪贴板未能恢复，识别文字已保留';
  constructor() { super('原剪贴板恢复写入失败，识别文字已保留'); }
}

export type ClipboardPort = {
  snapshot: (cancelled?: () => boolean) => PasteboardSnapshot;
  replace: (items: PasteboardItem[], expected: number, cancelled?: () => boolean) => number | null;
  owns: (changeCount: number, marker: string) => boolean;
  changeCount: () => number;
};

/** Lives on the pasteboard thread. Originals never leave that thread or reach disk. */
export function createClipboardLease(port: ClipboardPort) {
  let current: { id: string; original: PasteboardSnapshot; version: number; cleared?: boolean } | undefined;
  function restore(id?: string): 'restored' | 'superseded' | 'none' {
    const lease = current;
    if (!lease || (id && id !== lease.id)) return 'none';
    // Leave the lease intact on an exception so a later cleanup can try again.
    if (!(lease.cleared ? port.changeCount() === lease.version : port.owns(lease.version, lease.id))) {
      current = undefined; erasePasteboard(lease.original.items); return 'superseded';
    }
    let result: number | null;
    try { result = port.replace(lease.original.items, lease.version); }
    catch (error) {
      // A failed restore can itself leave the pasteboard empty. Keep both the
      // original bytes and our exact empty version for a later cleanup attempt.
      if (error instanceof PasteboardWriteError && port.changeCount() === error.clearCount) {
        lease.version = error.clearCount; lease.cleared = true;
      }
      throw error;
    }
    current = undefined; erasePasteboard(lease.original.items);
    return result === null ? 'superseded' : 'restored';
  }
  function finish(id?: string): 'restored' | 'superseded' | 'none' {
    try { return restore(id); }
    catch { throw new ClipboardRestoreError(); }
  }
  function claim(text: string, cancelled: () => boolean): string {
    if (cancelled()) throw new Error('已取消输入');
    finish(); // Never snapshot a previous dictation as the user's original.
    const original = port.snapshot(cancelled), id = randomUUID();
    const temporary: PasteboardItem[] = [[
      { type: 'public.utf8-plain-text', data: Buffer.from(text, 'utf8') },
      { type: PASTE_MARKER, data: Buffer.from(id, 'utf8') },
    ]];
    let handedOff = false;
    try {
      const version = port.replace(temporary, original.changeCount, cancelled);
      if (version === null) throw new Error('剪贴板刚刚变化，请复制识别文字');
      current = { id, original, version }; handedOff = true;
      if (!port.owns(version, id)) { finish(id); throw new Error('剪贴板刚刚变化，请复制识别文字'); }
      if (cancelled()) { finish(id); throw new Error('已取消输入'); }
      return id;
    } catch (error) {
      // A failed first write may have left our clearContents version empty.
      // Restore only that exact version, never a later user copy.
      if (!handedOff && error instanceof PasteboardWriteError && port.changeCount() === error.clearCount) {
        current = { id, original, version: error.clearCount, cleared: true }; handedOff = true;
        finish(id);
      }
      throw error;
    } finally { erasePasteboard(temporary); if (!handedOff) erasePasteboard(original.items); }
  }
  return { claim, finish, owned: (id: string) => !!current && current.id === id && port.owns(current.version, id),
    copy(text: string, cancelled: () => boolean) {
      finish();
      if (cancelled()) throw new Error('复制已取消');
      const items = [[{ type: 'public.utf8-plain-text', data: Buffer.from(text, 'utf8') }]];
      try {
        if (port.replace(items, port.changeCount(), cancelled) === null) throw new Error('剪贴板刚刚变化，请重新复制');
      } finally { erasePasteboard(items); }
    },
    discard() { if (current) erasePasteboard(current.original.items); current = undefined; },
  };
}

export type PasteClipboard = {
  claim: (text: string, signal: AbortSignal) => Promise<string>;
  owned: (id: string) => Promise<boolean>;
  finish: (id?: string) => Promise<unknown>;
  copy: (text: string) => Promise<void>;
  close: () => Promise<void>;
};
