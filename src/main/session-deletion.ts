import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionResult } from '../shared/types';
import type { SessionStore } from './store/sessions.ts';

const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
export type DeletionNotice = { sessionId: string; title: string; expiresAt: number; error?: string };

/** Keep an atomic, recoverable directory during undo; only the OS moves it to Trash. */
export function createSessionDeletion(opts: {
  store: SessionStore;
  active: (id: string) => boolean;
  quiesce: (id: string) => Promise<void>;
  trash: (path: string) => Promise<void>;
  changed: (id: string, restored: boolean, nextId?: string) => void;
  undoMs?: number;
}) {
  const root = join(opts.store.rootDir, 'pending-deletions');
  const busy = new Set<string>();
  const notices = new Map<string, DeletionNotice>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;

  function restoreDirectory(id: string): void {
    const source = join(root, id), dest = opts.store.sessionDir(id);
    if (existsSync(dest)) throw new Error('原位置已存在会话，待恢复的录音仍保留在本地');
    renameSync(source, dest);
    opts.store.invalidate(id);
  }

  async function commit(id: string): Promise<void> {
    const notice = notices.get(id);
    if (!notice || busy.has(id) || closed) return;
    busy.add(id); timers.delete(id);
    try {
      await opts.trash(join(root, id));
      notices.delete(id);
    } catch {
      notice.error = '未能移到废纸篓，录音仍安全保留。请恢复后重试。';
      notice.expiresAt = 0;
    } finally {
      busy.delete(id);
      opts.changed(id, false);
    }
  }

  async function remove(raw: unknown): Promise<ActionResult> {
    if (!validId(raw)) return { ok: false, error: '找不到这场会' };
    const id = raw;
    if (closed || busy.has(id) || notices.has(id)) return { ok: false, error: '这场会正在处理删除' };
    const doc = opts.store.readSession(id);
    if (!doc) return { ok: false, error: '找不到这场会' };
    if (opts.active(id) || doc.status === 'recording') return { ok: false, error: '请先停止录制并保存' };
    const rows = opts.store.listSummaries();
    const index = rows.findIndex(row => row.id === id);
    const nextId = (rows[index + 1] ?? rows[index - 1])?.id;
    busy.add(id);
    try {
      // Abort and await every writer before moving the directory, including playback handles.
      await opts.quiesce(id);
      if (closed || opts.active(id)) return { ok: false, error: '当前不能删除，请稍后重试' };
      const source = opts.store.sessionDir(id);
      if (lstatSync(source).isSymbolicLink()) return { ok: false, error: '不能删除链接目录' };
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const dest = join(root, id);
      if (existsSync(dest)) return { ok: false, error: '已有待恢复的会话，请先恢复' };
      renameSync(source, dest);
      opts.store.invalidate(id);
      notices.set(id, { sessionId: id, title: doc.title, expiresAt: Date.now() + (opts.undoMs ?? 8000) });
      timers.set(id, setTimeout(() => { void commit(id); }, opts.undoMs ?? 8000));
      opts.changed(id, false, nextId);
      return { ok: true };
    } catch {
      return { ok: false, error: '会话没有删除，请检查存储空间或权限后重试' };
    } finally { busy.delete(id); }
  }

  function undo(raw: unknown): ActionResult {
    if (!validId(raw)) return { ok: false, error: '无法恢复这场会' };
    const notice = notices.get(raw);
    if (!notice || busy.has(raw) || (!notice.error && Date.now() >= notice.expiresAt)) return { ok: false, error: '撤销时间已过，可从系统废纸篓找回' };
    try {
      restoreDirectory(raw);
      clearTimeout(timers.get(raw)); timers.delete(raw); notices.delete(raw);
      opts.changed(raw, true);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error && error.message.includes('原位置') ? error.message : '恢复没能完成，录音仍保留，请重试' };
    }
  }

  function recover(): void {
    if (!existsSync(root)) return;
    // A crash/quit before Trash completes must favor retaining the recording.
    for (const id of readdirSync(root)) {
      if (!validId(id) || lstatSync(join(root, id)).isSymbolicLink()) continue;
      try { restoreDirectory(id); }
      catch { notices.set(id, { sessionId: id, title: '待恢复的会话', expiresAt: 0, error: '会话仍保留在本地，点击恢复重试' }); }
    }
  }

  return {
    remove, undo, recover,
    blocked: (id: string) => busy.has(id) || notices.has(id),
    snapshot: () => [...notices.values()].map(value => ({ ...value })),
    close: () => { closed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
  };
}
