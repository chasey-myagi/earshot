import type { RealtimeStatus, Track } from "../shared/types";
import { createRealtimeSession, type RealtimeSentence, type RealtimeSession, type SocketConnect } from "./providers/realtime.ts";

/** One recording owns two sockets. Replacing them never resets the recorded audio clock. */
export function createLiveTranscriber(opts: {
  apiKey: string;
  connect?: SocketConnect;
  onSentence: (track: Track, sentence: RealtimeSentence) => void;
  onStatus: (status: RealtimeStatus) => void;
}) {
  let generation = 0;
  let stopped = false;
  let status: RealtimeStatus = "connecting";
  let sessions: Partial<Record<Track, RealtimeSession>> = {};
  const samples: Record<Track, number> = { you: 0, other: 0 };

  function publish(next: RealtimeStatus): void { status = next; opts.onStatus(next); }
  function close(): void {
    generation += 1;
    const previous = sessions;
    sessions = {};
    for (const session of Object.values(previous)) session.stop();
  }
  function connect(retry: boolean): void {
    close();
    const round = generation;
    const ready = new Set<Track>();
    const current = () => !stopped && generation === round;
    const lost = () => {
      if (!current()) return;
      close();
      publish("disconnected");
    };
    publish(retry ? "reconnecting" : "connecting");
    for (const track of ["you", "other"] as const) {
      if (!current()) break;
      try {
        const session = createRealtimeSession({
          apiKey: opts.apiKey, connect: opts.connect,
          onSentence: sentence => {
            if (current()) opts.onSentence(track, { ...sentence, sentenceId: `g${round}:${sentence.sentenceId}` });
          },
          onReady: () => {
            if (!current()) return;
            ready.add(track);
            if (ready.size === 2) publish("connected");
          },
          onError: lost,
        });
        if (current()) sessions[track] = session;
        else session.stop();
      } catch { lost(); }
    }
  }
  connect(false);
  return {
    sendPcm(track: Track, pcm: Buffer): void {
      if (stopped) return;
      const offsetMs = samples[track] / 16;
      samples[track] += pcm.length / 2;
      sessions[track]?.sendPcm(pcm, offsetMs);
    },
    retry(): boolean {
      if (stopped || status !== "disconnected") return false;
      connect(true);
      return true;
    },
    stop(): void { stopped = true; close(); },
  };
}

export type LiveTranscriber = ReturnType<typeof createLiveTranscriber>;
