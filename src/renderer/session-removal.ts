import type { ActionResult } from '../shared/types';

/** All renderer entry points join the same in-flight deletion for a session. */
export function createSessionRemover(send: (id: string) => Promise<ActionResult>) {
  const pending = new Map<string, Promise<ActionResult>>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  return {
    isPending: (id: string) => pending.has(id),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    remove(id: string): Promise<ActionResult> {
      const existing = pending.get(id);
      if (existing) return existing;
      const request = Promise.resolve().then(() => send(id)).finally(() => { pending.delete(id); emit(); });
      pending.set(id, request); emit();
      return request;
    },
  };
}

export const sessionRemoval = createSessionRemover(id => window.earshot.deleteSession(id));
