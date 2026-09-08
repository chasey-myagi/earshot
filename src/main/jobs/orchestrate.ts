import type { ActionResult } from "../../shared/types";
import type { SessionStore } from "../store/sessions.ts";
import { repairSessionWavs, sessionDurationSec } from "../store/wav.ts";
import { processSession } from "./post.ts";

export type JobMode = "all" | "refined" | "speakers";

export type JobFailReasons = Map<string, { refined?: string; speakers?: string }>;

const limits = new WeakMap<Set<string>, { active: number; waiting: (() => void)[] }>();

function runBounded(key: Set<string>, signal: AbortSignal, work: () => Promise<void>, canceled: () => void): Promise<void> {
  const limit = limits.get(key) ?? { active: 0, waiting: [] };
  limits.set(key, limit);
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = limit.waiting.indexOf(start);
      if (index >= 0) limit.waiting.splice(index, 1);
      try { canceled(); resolve(); } catch (err) { reject(err); }
    };
    const start = () => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { abort(); return; }
      limit.active++;
      let task: Promise<void>;
      try { task = work(); } catch (err) { task = Promise.reject(err); }
      task.then(resolve, reject).finally(() => {
        limit.active--;
        limit.waiting.shift()?.();
      });
    };
    if (limit.active < 2) start();
    else { limit.waiting.push(start); signal.addEventListener("abort", abort, { once: true }); }
  });
}

export type PostQueue = {
  store: SessionStore;
  jobsInFlight: Set<string>;
  jobAbort: Map<string, AbortController>;
  jobFailReasons: JobFailReasons;
  pending?: Map<string, Promise<void>>;
  apiKey: string | null;
  process?: typeof processSession;
  onChange?: () => void;
};

export function queuePost(queue: PostQueue, sessionId: string, mode: JobMode, retryUncertainSubmission = false): ActionResult {
  if (queue.jobsInFlight.has(sessionId)) return { ok: false, error: "正在处理" };
  if (!queue.apiKey) return { ok: false, error: "没有密钥不能开始", code: "no_key" };
  const doc = queue.store.readSession(sessionId);
  if (!doc) return { ok: false, error: "找不到这场会" };
  const wantSpeakers = mode === "speakers" || (doc.autoDiarize ?? queue.store.readPrefs().autoDiarize);
  try {
    queue.store.patchJobs(sessionId, {
      refined: mode !== "speakers" ? { status: "running", reason: "等待处理" } : undefined,
      speakers: wantSpeakers ? { status: "running", reason: "等待处理" } : undefined,
    });
  } catch { return { ok: false, error: "处理任务没能保存，请重试" }; }
  queue.jobsInFlight.add(sessionId);
  const ac = new AbortController();
  queue.jobAbort.set(sessionId, ac);
  queue.jobFailReasons.delete(sessionId);
  const run = queue.process ?? processSession;
  const apiKey = queue.apiKey;
  const pending = runBounded(queue.jobsInFlight, ac.signal, () => run({
    apiKey,
    store: queue.store,
    sessionId,
    mode,
    signal: ac.signal,
    retryUncertainSubmission,
    onFail: (job, reason) => {
      const row = queue.jobFailReasons.get(sessionId) ?? {};
      row[job] = reason;
      queue.jobFailReasons.set(sessionId, row);
    },
    onChange: queue.onChange,
  }), () => {
    queue.store.patchJobs(sessionId, {
      refined: mode !== "speakers" ? { status: "canceled", reason: null } : undefined,
      speakers: wantSpeakers ? { status: "canceled", reason: null } : undefined,
    });
  }).finally(() => {
    queue.jobsInFlight.delete(sessionId);
    queue.jobAbort.delete(sessionId);
    queue.pending?.delete(sessionId);
    queue.onChange?.();
  }).catch(() => {
    // process 自己记失败；这里只保证 finally 清完后不把拒绝漏成未处理
  });
  queue.pending?.set(sessionId, pending);
  return { ok: true };
}

export function cancelJob(queue: PostQueue, sessionId: string): ActionResult {
  const ac = queue.jobAbort.get(sessionId);
  if (!ac) return { ok: false, error: "没有正在处理的任务" };
  if (ac.signal.aborted) return { ok: true };
  const doc = queue.store.readSession(sessionId);
  const refined = doc?.jobs.refined.status === "running";
  const speakers = doc?.jobs.speakers.status === "running";
  if (!refined && !speakers) return { ok: false, error: "没有正在处理的任务" };
  try {
    queue.store.patchJobs(sessionId, {
      refined: refined ? { status: "canceling" } : undefined,
      speakers: speakers ? { status: "canceling" } : undefined,
    });
  } catch { return { ok: false, error: "取消状态没能保存，请重试" }; }
  ac.abort();
  queue.onChange?.();
  return { ok: true };
}

export function finishRecordingJobs(
  queue: PostQueue,
  sessionId: string,
  reason: "stop" | "crash" | "quit",
): void {
  if (reason !== "quit") {
    void queuePost(queue, sessionId, "all");
    return;
  }
  // 退出时来不及跑精修/分离：标 failed，下次打开会库能看到「没完成 · 重试」，
  // 不能让有音轨的场次落进「complete + idle + 无入口」的死角
  const saved = queue.store.patchJobs(sessionId, {
    refined: { status: "failed" },
    speakers: { status: "failed" },
  });
  if (!saved) throw new Error("找不到待保存的会话");
}

export function recoverStuckJobs(queue: PostQueue): void {
  for (const row of queue.store.listSummaries()) {
    if (row.jobs.refined === "canceling" || row.jobs.speakers === "canceling") {
      queue.store.patchJobs(row.id, {
        refined: row.jobs.refined === "canceling" ? { status: "canceled", reason: null } : undefined,
        speakers: row.jobs.speakers === "canceling" ? { status: "canceled", reason: null } : undefined,
      });
      continue;
    }
    if (!queue.apiKey) continue;
    if (row.status === "recording") continue;
    if (row.jobs.refined !== "running" && row.jobs.speakers !== "running") continue;
    void queuePost(queue, row.id, row.jobs.refined === "running" ? "all" : "speakers");
  }
}

export function settleSession(
  store: SessionStore,
  sessionId: string,
  startedAt: string,
  code: number | null,
  stoppedAt = new Date().toISOString(),
): void {
  const dir = store.sessionDir(sessionId);
  repairSessionWavs(dir);
  const wall = Math.max(0, Math.floor((Date.parse(stoppedAt) - Date.parse(startedAt)) / 1000));
  const saved = store.finalize(sessionId, code === 0 ? "complete" : "incomplete", {
    durationSec: sessionDurationSec(dir, wall),
    endedAt: stoppedAt,
  });
  if (!saved) throw new Error("找不到待保存的会话");
}

export function abortRecordingStart(opts: {
  store: SessionStore;
  sessionId: string;
  stopRealtime: () => void;
  clearLive: () => void;
  stoppedAt?: string;
}): void {
  opts.stopRealtime();
  if (!opts.store.discardEmptyRecording(opts.sessionId)) {
    const doc = opts.store.readSession(opts.sessionId);
    if (!doc) throw new Error("找不到待保存的会话");
    const dir = opts.store.sessionDir(opts.sessionId);
    repairSessionWavs(dir);
    const saved = opts.store.finalize(opts.sessionId, "incomplete", {
      live: "idle", endedAt: opts.stoppedAt,
      durationSec: sessionDurationSec(dir, 0),
    });
    if (!saved) throw new Error("找不到待保存的会话");
  }
  opts.clearLive();
}
