import { randomUUID } from "node:crypto";
import type { ActionResult, RenameSpeakerInput, RenameSpeakerResult } from "../shared/types";
import type { SessionStore } from "./store/sessions.ts";
import { sessionTranscript } from "./store/transcript.ts";
import { enrollSpeaker } from "./voiceprint/enroll.ts";

type UndoState = { before: Record<string, string>; expiresAt: number; pendingRoots: string[] };
type Registration = {
  id: string; sessionId: string; to: string;
  roots: string[]; artifact: string; undo?: UndoState;
  timer: ReturnType<typeof setTimeout>;
};

/** Registrations own raw clusters; only a user rename grants an undo capability. */
export function createSpeakerNames(opts: {
  store: SessionStore; undoMs?: number; enroll?: typeof enrollSpeaker;
}) {
  const { store } = opts;
  const pending = new Map<string, Registration>();
  const owners = new Map<string, string>();
  const rootKey = (sessionId: string, root: string) => JSON.stringify([sessionId, root]);
  function artifact(id: string): string {
    const doc = store.readSession(id);
    return JSON.stringify([doc?.jobs.refined.current, doc?.jobs.speakers.current]);
  }
  function current(change: Registration): boolean {
    if (!pending.has(change.id) || artifact(change.sessionId) !== change.artifact) return false;
    const names = store.readNames(change.sessionId);
    return change.roots.every(root => names[root] === change.to && owners.get(rootKey(change.sessionId, root)) === change.id);
  }
  function forget(change: Registration): void {
    clearTimeout(change.timer);
    pending.delete(change.id);
    for (const root of change.roots) {
      const key = rootKey(change.sessionId, root);
      if (owners.get(key) === change.id) owners.delete(key);
    }
  }
  async function register(change: Registration): Promise<void> {
    try {
      if (!current(change)) return;
      store.rememberPerson(change.to);
      for (const root of change.roots) {
        if (!current(change)) return;
        await (opts.enroll ?? enrollSpeaker)({ store, sessionId: change.sessionId, from: root, to: change.to,
          isCurrent: () => current(change) });
      }
    } catch { console.warn("[earshot] speaker name saved; voice registration unavailable"); }
    finally { forget(change); }
  }
  function schedule(sessionId: string, to: string, roots: string[], undo?: UndoState): Registration {
    const id = randomUUID();
    const change: Registration = { id, sessionId, to, roots, undo, artifact: artifact(sessionId),
      timer: setTimeout(() => { void register(change); }, undo ? Math.max(0, undo.expiresAt - Date.now()) : 0) };
    for (const root of roots) owners.set(rootKey(sessionId, root), id);
    pending.set(id, change);
    return change;
  }
  function rename(input: RenameSpeakerInput): RenameSpeakerResult {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.sessionId)) return { ok: false, error: "找不到这场会" };
    const from = input.from.trim(), to = input.to.trim();
    if (!from || !to || to.length > 80 || to === "你") return { ok: false, error: "请填写 1–80 字的对方名字" };
    const doc = store.readSession(input.sessionId);
    if (!doc || doc.status === "recording") return { ok: false, error: "停止录音后即可起名" };
    const before = store.readNames(input.sessionId);
    const affected = sessionTranscript(store.sessionDir(input.sessionId), doc.jobs.refined.current, {})
      .filter(turn => turn.track === "other" && (Object.hasOwn(before, turn.speaker) ? before[turn.speaker] : turn.speaker) === from);
    const roots = [...new Set(affected.map(turn => turn.speaker))];
    if (!roots.length) return { ok: false, error: "这位说话人已更新，请重新选择" };
    if (from === to) return { ok: true };
    const pendingRoots = roots.filter(root => {
      const previous = pending.get(owners.get(rootKey(input.sessionId, root)) ?? "");
      return previous !== undefined && current(previous);
    });
    try { store.writeNames(input.sessionId, Object.fromEntries([...Object.entries(before), ...roots.map(root => [root, to])])); }
    catch { return { ok: false, error: "名字没能保存，请重试" }; }
    const expiresAt = Date.now() + (opts.undoMs ?? 8000);
    const change = schedule(input.sessionId, to, roots, { before, expiresAt, pendingRoots });
    return { ok: true, undoId: change.id, expiresAt, changedTurns: affected.length };
  }
  function undo(id: string): ActionResult {
    const change = pending.get(id);
    if (!change?.undo || Date.now() >= change.undo.expiresAt || !current(change)) return { ok: false, error: "这次改名已更新或撤销时间已过" };
    const { before, pendingRoots } = change.undo;
    const names = store.readNames(change.sessionId);
    for (const root of change.roots) {
      if (Object.hasOwn(before, root)) Object.defineProperty(names, root, { value: before[root], enumerable: true, configurable: true, writable: true });
      else delete names[root];
    }
    try { store.writeNames(change.sessionId, names); }
    catch { return { ok: false, error: "撤销没能保存，请重试" }; }
    forget(change);
    // Resume only registration work displaced by this rename. Historical maps
    // alone do not grant new side effects, and no old undo token is reactivated.
    const restored = new Map<string, string[]>();
    for (const root of pendingRoots) {
      const to = before[root];
      restored.set(to, [...(restored.get(to) ?? []), root]);
    }
    for (const [to, roots] of restored) schedule(change.sessionId, to, roots);
    return { ok: true };
  }
  function invalidate(sessionId: string): void {
    for (const change of pending.values()) if (change.sessionId === sessionId) {
      try { if (current(change)) store.rememberPerson(change.to); } catch { /* local names remain saved */ }
      forget(change);
    }
  }
  function close(): void {
    // A deliberate app quit ends the undo period. Keep the name for next time;
    // optional embedding must never hold up quitting or write after invalidation.
    for (const change of pending.values()) {
      try { if (current(change)) store.rememberPerson(change.to); } catch { /* local names remain saved */ }
      forget(change);
    }
  }
  return { rename, undo, invalidate, close };
}
