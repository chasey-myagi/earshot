import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SHORTCUTS, type ShortcutPrefs } from '../../shared/dictation.ts';
import { normalizeShortcut } from '../../shared/shortcuts.ts';
import { DICTATION_MODELS, POLISH_MODELS } from '../../shared/model-settings.ts';
import type { ActionResult } from '../../shared/types';

function parse(raw: unknown): ShortcutPrefs | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as ShortcutPrefs;
  if (typeof value.enabled !== 'boolean' || !normalizeShortcut(value.meeting) || !normalizeShortcut(value.dictation) || normalizeShortcut(value.meeting) === normalizeShortcut(value.dictation) || !['direct', 'preview'].includes(value.delivery)) return null;
  if (value.wechatCompatibility !== undefined && typeof value.wechatCompatibility !== 'boolean') return null;
  if (value.models && (!DICTATION_MODELS.some(m => m.id === value.models?.asr) || !POLISH_MODELS.some(m => m.id === value.models?.polish))) return null;
  return { enabled: value.enabled, meeting: normalizeShortcut(value.meeting)!, dictation: normalizeShortcut(value.dictation)!, delivery: value.delivery, wechatCompatibility: value.wechatCompatibility === true, ...(value.models ? { models: { ...value.models } } : {}) };
}

export function createShortcutSettings(opts: {
  root: string;
  register: (key: string, callback: () => void) => boolean;
  unregister: (key: string) => void;
  meeting: () => void;
  dictation: () => void;
}) {
  const path = join(opts.root, 'shortcuts.json');
  let prefs = { ...DEFAULT_SHORTCUTS }, error: string | undefined;
  const registered = new Set<string>();
  if (existsSync(path)) { try { prefs = parse(JSON.parse(readFileSync(path, 'utf8'))) ?? prefs; } catch { /* preserve defaults */ } }
  function apply(next: ShortcutPrefs, persist: boolean): ActionResult {
    const wanted = new Map<string, () => void>([[next.meeting, opts.meeting], ...(next.enabled ? [[next.dictation, opts.dictation] as [string, () => void]] : [])]);
    const added: string[] = [];
    try {
      for (const [key, callback] of wanted) {
        if (registered.has(key)) continue;
        if (!opts.register(key, () => key === prefs.meeting ? opts.meeting() : opts.dictation())) throw new Error(`快捷键 ${key} 已被占用，请换一个组合`);
        added.push(key);
      }
      if (persist) {
        mkdirSync(opts.root, { recursive: true, mode: 0o700 });
        const temp = `${path}.${randomUUID()}.tmp`;
        try { writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); renameSync(temp, path); }
        finally { rmSync(temp, { force: true }); }
      }
    } catch (reason) {
      for (const key of added) opts.unregister(key);
      error = reason instanceof Error && reason.message.startsWith('快捷键 ') ? reason.message : '快捷键设置未能保存，请重试';
      return { ok: false, error };
    }
    for (const key of registered) if (!wanted.has(key)) opts.unregister(key);
    registered.clear(); for (const key of wanted.keys()) registered.add(key);
    prefs = next; error = undefined;
    return { ok: true };
  }
  return {
    start: (): ActionResult => {
      const failures: string[] = [];
      for (const [name, key] of [['录制', prefs.meeting], ...(prefs.enabled ? [['语音输入', prefs.dictation]] : [])]) {
        if (registered.has(key)) continue;
        try { if (opts.register(key, () => key === prefs.meeting ? opts.meeting() : opts.dictation())) registered.add(key); else failures.push(`${name}快捷键 ${key} 已被占用`); }
        catch { failures.push(`${name}快捷键 ${key} 注册失败`); }
      }
      error = failures.length ? failures.join('；') : undefined;
      return error ? { ok: false, error } : { ok: true };
    },
    snapshot: () => ({ prefs: { ...prefs }, ...(error ? { error } : {}) }),
    save: (raw: unknown): ActionResult => { const next = parse(raw); return next ? apply(next, true) : { ok: false, error: '无效的快捷键设置' }; },
    pause: () => { for (const key of registered) opts.unregister(key); registered.clear(); },
    close: () => { for (const key of registered) opts.unregister(key); registered.clear(); },
  };
}
