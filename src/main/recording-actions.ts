import type { ActionResult, CapturePhase } from "../shared/types";

export type StopReason = "stop" | "crash" | "quit";

/** Serialize the two asynchronous capture actions, including quit during startup. */
export function createRecordingActions(opts: {
  start: () => Promise<ActionResult>;
  finish: (reason: StopReason) => Promise<void>;
  hasUnfinished?: () => boolean;
  onChange: () => void;
}) {
  let phase: CapturePhase = "idle";
  let starting: Promise<ActionResult> | null = null;
  let stopping: Promise<ActionResult> | null = null;
  function setPhase(next: CapturePhase): void { phase = next; opts.onChange(); }
  return {
    phase: () => phase,
    start(): Promise<ActionResult> {
      if (starting) return starting;
      if (phase !== "idle") return Promise.resolve({ ok: false, code: "busy", error: "已有正在进行的录音" });
      setPhase("starting");
      starting = opts.start().then(result => {
        setPhase(result.ok ? "recording" : opts.hasUnfinished?.() ? "finalize_failed" : "idle");
        return result;
      }, () => {
        const unfinished = opts.hasUnfinished?.();
        setPhase(unfinished ? "finalize_failed" : "idle");
        return { ok: false, error: unfinished ? "录音已停止，保存尚未完成，请重试保存" : "录音没启动，请重试" } as ActionResult;
      }).finally(() => { starting = null; });
      return starting;
    },
    stop(reason: StopReason): Promise<ActionResult> {
      if (stopping) return stopping;
      stopping = (async (): Promise<ActionResult> => {
        if (starting) await starting;
        if (phase !== "recording" && phase !== "finalize_failed") return { ok: false, error: "没有正在进行的录音" };
        setPhase("stopping");
        try {
          await opts.finish(reason);
          setPhase("idle");
          return { ok: true };
        } catch {
          // The recording still owns unfinished persistence; retry must reach finish again.
          setPhase("finalize_failed");
          return { ok: false, error: "录音收尾失败，请重试停止" };
        }
      })().finally(() => { stopping = null; });
      return stopping;
    },
  };
}
