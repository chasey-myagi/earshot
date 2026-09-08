import { randomUUID } from "node:crypto";
import type { RealtimeConnectionDetail, RealtimeStatus, RealtimeTrackConnection, Track } from "../shared/types";
import { createRealtimeSession, type RealtimeFailure, type RealtimeSentence, type RealtimeSession, type SocketConnect } from "./providers/realtime.ts";
import type { RealtimeEvent } from "./realtime-events.ts";

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];
const TRACKS = ["you", "other"] as const;
type TrackState = RealtimeTrackConnection & {
  generation: number; samples: number; taskId: string; session?: RealtimeSession;
  retryTimer?: ReturnType<typeof setTimeout>; stableTimer?: ReturnType<typeof setTimeout>;
};

/** Each track owns its recovery budget; recorded sample clocks never reset on reconnect. */
export function createLiveTranscriber(opts: {
  apiKey: string; connect?: SocketConnect;
  onSentence: (track: Track, sentence: RealtimeSentence) => void;
  onStatus: (status: RealtimeStatus, detail: RealtimeConnectionDetail) => void;
  onTrackLost?: (track: Track) => void;
  onEvent?: (event: RealtimeEvent) => void;
}) {
  let stopped = false;
  const fresh = (): TrackState => ({ status: "connecting", attempt: 0, generation: 0, samples: 0, taskId: "" });
  const tracks: Record<Track, TrackState> = { you: fresh(), other: fresh() };
  function publish(): void {
    const status = TRACKS.every(track => tracks[track].status === "connected") ? "connected"
      : TRACKS.some(track => tracks[track].status === "disconnected") ? "disconnected"
      : TRACKS.some(track => tracks[track].status === "reconnecting") ? "reconnecting" : "connecting";
    const detail = (s: TrackState): RealtimeTrackConnection => ({ status: s.status, attempt: s.attempt,
      ...(s.category ? { category: s.category } : {}), ...(s.retryDelayMs !== undefined ? { retryDelayMs: s.retryDelayMs } : {}) });
    opts.onStatus(status, { tracks: { you: detail(tracks.you), other: detail(tracks.other) } });
  }
  function event(track: Track, kind: RealtimeEvent["event"], failure?: RealtimeFailure): void {
    const s = tracks[track];
    try { opts.onEvent?.({ track, at: Date.now(), event: kind, attempt: s.attempt, taskId: s.taskId,
      ...(failure ? { category: failure.category, ...(failure.providerCode ? { providerCode: failure.providerCode } : {}) } : {}),
      ...(s.retryDelayMs !== undefined ? { retryDelayMs: s.retryDelayMs } : {}) }); } catch { /* diagnostics are best effort */ }
  }
  function release(s: TrackState): void {
    s.generation += 1;
    clearTimeout(s.retryTimer); clearTimeout(s.stableTimer);
    s.retryTimer = undefined; s.stableTimer = undefined;
    const session = s.session; s.session = undefined;
    session?.stop();
  }
  function connect(track: Track): void {
    const s = tracks[track]; release(s);
    const round = s.generation;
    const current = () => !stopped && s.generation === round;
    s.taskId = randomUUID(); s.retryDelayMs = undefined;
    s.status = s.attempt > 0 || round > 1 ? "reconnecting" : "connecting";
    event(track, "connecting"); publish();
    const lost = (_message: string, failure: RealtimeFailure): void => {
      if (!current()) return;
      release(s); s.category = failure.category; s.retryDelayMs = undefined;
      event(track, "failed", failure); opts.onTrackLost?.(track);
      if (failure.retryable && s.attempt < RETRY_DELAYS.length) {
        s.retryDelayMs = RETRY_DELAYS[s.attempt++]; s.status = "reconnecting";
        event(track, "retry-scheduled", failure);
        const waiting = s.generation;
        s.retryTimer = setTimeout(() => { if (!stopped && s.generation === waiting) connect(track); }, s.retryDelayMs);
        s.retryTimer.unref();
      } else {
        s.status = "disconnected"; event(track, "retry-exhausted", failure);
      }
      publish();
    };
    try {
      const session = createRealtimeSession({ apiKey: opts.apiKey, connect: opts.connect, taskId: s.taskId,
        onSentence: sentence => { if (current()) opts.onSentence(track, { ...sentence, sentenceId: `g${round}:${sentence.sentenceId}` }); },
        onReady: () => {
          if (!current()) return;
          s.status = "connected"; s.category = undefined; event(track, "connected");
          s.stableTimer = setTimeout(() => { if (current()) { s.attempt = 0; publish(); } }, 30_000);
          s.stableTimer.unref(); publish();
        }, onError: lost });
      if (current()) s.session = session; else session.stop();
    } catch { lost("实时转写连接失败", { category: "transport", retryable: true, taskId: s.taskId }); }
  }
  for (const track of TRACKS) connect(track);
  return {
    sendPcm(track: Track, pcm: Buffer): void {
      if (stopped) return;
      const s = tracks[track], offsetMs = s.samples / 16;
      s.samples += pcm.length / 2; s.session?.sendPcm(pcm, offsetMs);
    },
    retry(): boolean {
      if (stopped) return false;
      const failed = TRACKS.filter(track => tracks[track].status === "disconnected");
      if (!failed.length) return false;
      for (const track of failed) { tracks[track].attempt = 0; connect(track); }
      return true;
    },
    stop(): void { if (stopped) return; stopped = true; for (const track of TRACKS) { release(tracks[track]); event(track, "stopped"); } },
  };
}
export type LiveTranscriber = ReturnType<typeof createLiveTranscriber>;
