import type { AppSnapshot, CapturePhase, PermissionState, PlaybackState, RealtimeStatus, SessionJobs, TranscriptTurn } from "../../shared/types";
import type { SessionStore } from "./sessions";

export type RecordingRuntime = {
  sessionId: string;
  startedAt: string;
  stoppedAt?: string;
  glanceVisible: boolean;
  connection?: RealtimeStatus;
  storageWarning?: string;
  turns?: TranscriptTurn[];
};

export type JobFailReasons = Map<string, { refined?: string; speakers?: string }>;

export type SnapshotRuntime = {
  hasApiKey: boolean;
  permissions: { microphone: PermissionState; screen: PermissionState };
  recording: RecordingRuntime | null;
  playingSessionId: string | null;
  playback?: PlaybackState | null;
  capturePhase?: CapturePhase;
  selectedId: string | null;
  libraryRequest?: number;
  jobFailReasons?: JobFailReasons;
  now?: number;
};

function mergeJobReasons(jobs: SessionJobs, reasons?: { refined?: string; speakers?: string }): SessionJobs {
  if (!reasons) return jobs;
  return {
    ...jobs,
    failedReason: jobs.refined === "failed" ? reasons.refined : undefined,
    speakersFailReason: jobs.speakers === "failed" ? reasons.speakers : undefined,
  };
}

export function assembleSnapshot(store: SessionStore, runtime: SnapshotRuntime): AppSnapshot {
  const now = runtime.now ?? Date.now();
  const recordingDuration = runtime.recording ? Math.max(0, Math.floor(
    ((runtime.recording.stoppedAt ? Date.parse(runtime.recording.stoppedAt) : now)
      - Date.parse(runtime.recording.startedAt)) / 1000,
  )) : 0;
  const sessions = store.listSummaries().map((row) => ({
    ...row,
    durationSec: row.id === runtime.recording?.sessionId
      ? recordingDuration : row.durationSec,
    jobs: mergeJobReasons(row.jobs, runtime.jobFailReasons?.get(row.id)),
  }));
  const selectedId = runtime.selectedId;
  const liveSummary = sessions.find(row => row.id === selectedId && row.id === runtime.recording?.sessionId);
  // Live text already comes from the recording buffer; avoid rereading an ever-growing JSONL file each frame.
  const selected = liveSummary && runtime.recording?.turns ? {
    ...liveSummary, endedAt: null, turns: runtime.recording.turns, people: [],
    durationSec: recordingDuration,
  } : selectedId ? store.getDetail(selectedId) : null;
  return {
    hasApiKey: runtime.hasApiKey,
    autoDiarize: store.readPrefs().autoDiarize,
    permissions: runtime.permissions,
    playingSessionId: runtime.playingSessionId,
    playback: runtime.playback ? { ...runtime.playback,
      title: sessions.find(row => row.id === runtime.playback?.sessionId)?.title ?? runtime.playback.title,
    } : null,
    capturePhase: runtime.capturePhase ?? (runtime.recording ? "recording" : "idle"),
    recording: runtime.recording
      ? {
          sessionId: runtime.recording.sessionId,
          elapsedSec: recordingDuration,
          glanceVisible: runtime.recording.glanceVisible,
          connection: runtime.recording.connection ?? "connecting",
          storageWarning: runtime.recording.storageWarning,
          phase: runtime.capturePhase ?? "recording",
          turns: runtime.recording.turns ?? [],
        }
      : null,
    sessions,
    selectedId,
    libraryRequest: runtime.libraryRequest ?? 0,
    selected: selected
      ? {
          ...selected,
          turns: selected.id === runtime.recording?.sessionId
            ? runtime.recording.turns ?? selected.turns
            : selected.turns,
          jobs: mergeJobReasons(selected.jobs, runtime.jobFailReasons?.get(selected.id)),
        }
      : null,
  };
}
