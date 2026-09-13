import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ActionResult } from "../../shared/types";
import { AUTO_TITLE_MIN_CHARACTERS, AUTO_TITLE_MIN_SECONDS } from "../../shared/auto-title.ts";
import { generateSessionTitle } from "../providers/session-title.ts";
import type { SessionStore } from "../store/sessions.ts";
import { readRefinedFile } from "../store/transcript.ts";

/** A small optional follow-up inside the main process; ASR owns its own lifecycle. */
export function createSessionTitles(opts: {
  store: SessionStore;
  apiKey: () => string | null;
  blocked: (id: string) => boolean;
  quitting: () => boolean;
  changed: () => void;
  generate?: typeof generateSessionTitle;
}) {
  const running = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  function start(id: string, parentSignal?: AbortSignal): Promise<void> {
    const existing = running.get(id);
    if (existing) return existing.promise;
    if (opts.quitting() || opts.blocked(id) || parentSignal?.aborted) return Promise.resolve();
    const doc = opts.store.readSession(id);
    if (!doc || doc.kind === "dictation" || doc.status === "recording" || !doc.endedAt
      || doc.titleSource !== "default" || doc.autoTitle?.state !== "pending"
      || doc.jobs.refined.status !== "done" || !doc.jobs.refined.current) return Promise.resolve();
    if (!opts.store.readPrefs().autoTitle) {
      try { opts.store.skipAutoTitle(id); } catch { /* A disabled preference still prevents all requests. */ }
      return Promise.resolve();
    }
    const apiKey = opts.apiKey();
    if (!apiKey) return Promise.resolve();
    const artifact = doc.jobs.refined.current;
    const text = readRefinedFile(join(opts.store.sessionDir(id), artifact)).filter(turn => !turn.partial).map(turn => turn.text).join("\n");
    const characters = text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    if (!Number.isFinite(doc.durationSec) || doc.durationSec < AUTO_TITLE_MIN_SECONDS || characters < AUTO_TITLE_MIN_CHARACTERS) {
      try { opts.store.skipAutoTitle(id); } catch { /* Rechecking this local gate cannot incur a cloud request. */ }
      return Promise.resolve();
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    const requestId = randomUUID(), revision = doc.titleRevision ?? 0;
    // Defer the first operation until the map owns the promise, including for synchronous test providers.
    const promise = Promise.resolve().then(async () => {
      if (controller.signal.aborted || opts.quitting() || opts.blocked(id)) return;
      if (!opts.store.beginAutoTitle(id, revision, artifact, requestId)) return;
      const title = await (opts.generate ?? generateSessionTitle)({ apiKey, text, signal: controller.signal, requestId });
      if (!title || controller.signal.aborted || opts.quitting() || opts.blocked(id)) return;
      if (opts.store.applyAutoTitle(id, { title, revision, artifact, requestId })) opts.changed();
    }).catch(() => {
      // Keep the original title and the persisted attempt; never affect transcription or log transcript text.
    }).finally(() => {
      parentSignal?.removeEventListener("abort", abort);
      running.delete(id);
    });
    running.set(id, { controller, promise });
    return promise;
  }

  async function cancel(id: string): Promise<void> {
    const entry = running.get(id);
    entry?.controller.abort();
    await entry?.promise;
  }

  async function cancelAll(): Promise<void> {
    const entries = [...running.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.all(entries.map(entry => entry.promise));
  }

  async function setEnabled(on: unknown): Promise<ActionResult> {
    if (typeof on !== "boolean") return { ok: false, error: "自动命名设置无效" };
    let result: ActionResult = { ok: true };
    try { opts.store.setAutoTitle(on); }
    catch { result = { ok: false, error: "自动命名设置未能完整保存，请重试" }; }
    if (!on) await cancelAll();
    opts.changed();
    return result;
  }

  async function recover(): Promise<void> {
    if (opts.quitting() || !opts.store.readPrefs().autoTitle) return;
    // A restart can expose several pending recordings; resume them one at a time.
    for (const row of opts.store.listSummaries()) await start(row.id);
  }

  return { start, cancel, cancelAll, setEnabled, recover };
}
