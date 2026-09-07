import type { JobStatus, SessionStatus } from "../../shared/types";

export type SessionDocument = {
  schema_version: 1;
  kind?: "recording" | "dictation";
  dictation?: import("../../shared/types").DictationDocument;
  id: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  status: SessionStatus;
  /** Captured when recording starts; absent on legacy sessions. */
  autoDiarize?: boolean;
  audio: { sampleRate: 16000; channels: 1; codec: "pcm_s16le" };
  tracks: { microphone: boolean; system: boolean };
  jobs: {
    live: JobStatus;
    refined: { status: JobStatus; current: string | null; reason?: string };
    speakers: { status: JobStatus; current: string | null; reason?: string };
  };
};

export type Prefs = {
  autoDiarize: boolean;
};
