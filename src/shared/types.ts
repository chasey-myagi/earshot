export type SessionStatus = "recording" | "complete" | "incomplete";
export type JobStatus = "idle" | "running" | "canceling" | "canceled" | "done" | "failed";
export type PermissionState = "undetermined" | "granted" | "denied";
export type Track = "you" | "other";
export type RealtimeStatus = "connecting" | "connected" | "disconnected" | "reconnecting";
export type RealtimeFailureCategory = "transport" | "ready-timeout" | "provider-timeout" | "server" | "rate-limit" | "auth" | "quota" | "invalid-request" | "provider" | "task-finished";
export type RealtimeTrackConnection = { status: RealtimeStatus; attempt: number; category?: RealtimeFailureCategory; retryDelayMs?: number };
export type RealtimeConnectionDetail = { tracks: Record<Track, RealtimeTrackConnection> };
export type CapturePhase = "idle" | "starting" | "recording" | "stopping" | "finalize_failed";

export type PlaybackStatus = "loading" | "playing" | "paused" | "ended" | "error";
export type PlaybackState = {
  sessionId: string;
  title: string;
  status: PlaybackStatus;
  positionSec: number;
  durationSec: number;
  rate: number;
  warning?: string;
  error?: string;
};
export type PlaybackCommand = {
  id: number;
  token: string;
  action: "load" | "pause" | "resume" | "seek" | "stop" | "rate";
  url?: string;
  positionSec?: number;
  resume?: boolean;
  rate?: number;
};
export type PlaybackReport = {
  token: string;
  commandId: number;
  status: PlaybackStatus | "idle";
  positionSec: number;
  ack?: boolean;
  rate?: number;
  error?: string;
};

export type SessionJobs = {
  waiting?: boolean;
  live: JobStatus;
  refined: JobStatus;
  speakers: JobStatus;
  failedReason?: string;
  speakersFailReason?: string;
};

export type DictationDocument = { text: string; rawText: string; asrModel: string; polishModel?: string; warning?: string };

export type SessionSummary = {
  kind?: "recording" | "dictation";
  id: string;
  title: string;
  startedAt: string;
  durationSec: number;
  status: SessionStatus;
  jobs: SessionJobs;
};

export type TranscriptTurn = {
  id: string;
  track: Track;
  speaker: string;
  tStartMs: number;
  tEndMs?: number;
  text: string;
  partial?: boolean;
  correction?: import('./transcript-tools').TurnCorrectionMeta;
};

export type SessionDetail = SessionSummary & {
  bookmarks?: import('./transcript-tools').Bookmark[];
  transcriptToolsError?: string;
  voiceRegistrations?: { name: string; status: "pending" | "running" | "remembered" | "insufficient" | "conflicting" | "unavailable" | "stale" }[];
  dictation?: DictationDocument;
  endedAt: string | null;
  turns: TranscriptTurn[];
  people: string[];
};

export type RecordingLive = {
  sessionId: string;
  elapsedSec: number;
  glanceVisible: boolean;
  connection?: RealtimeStatus;
  connectionDetail?: RealtimeConnectionDetail;
  storageWarning?: string;
  phase?: CapturePhase;
  turns: TranscriptTurn[];
};

export type AppSnapshot = {
  audioImport?: { phase: 'choosing' | 'decoding' | 'saving'; percent?: number; message: string };
  dictation?: import('./dictation').DictationState;
  shortcuts?: import('./dictation').ShortcutStatus;
  hasApiKey: boolean;
  autoDiarize: boolean;
  sharedMicrophone?: boolean;
  permissions: { microphone: PermissionState; screen: PermissionState };
  recording: RecordingLive | null;
  playingSessionId: string | null;
  playback?: PlaybackState | null;
  capturePhase?: CapturePhase;
  sessions: SessionSummary[];
  selectedId: string | null;
  selected: SessionDetail | null;
  libraryRequest?: number;
  settingsRequest?: number;
  deletions?: { sessionId: string; title: string; expiresAt: number; error?: string }[];
};

export type SaveKeyResult = { ok: true } | { ok: false; error: string };

export type ActionCode = "no_key" | "no_mic" | "no_screen" | "busy";
export type ActionResult = { ok: true } | { ok: false; error: string; code?: ActionCode };

export type ExportFormat = "json" | "txt";
export type ExportTranscriptInput = { sessionId: string; format: ExportFormat };
export type ExportTranscriptResult = { ok: true; canceled: boolean; saved?: { path: string; id: string } } | { ok: false; error: string };

export type RenameSpeakerInput = {
  sessionId: string;
  from: string;
  to: string;
};

export type RenameSpeakerResult = ActionResult & { undoId?: string; expiresAt?: number; changedTurns?: number };

export type RenameSessionInput = { sessionId: string; title: string };

export type RetryJobInput = {
  sessionId: string;
  job: "refined" | "speakers";
};

export type PrivacyPane = "microphone" | "screen";

export type EarshotApi = {
  searchTranscripts: (input: import('./transcript-tools').TranscriptSearchInput) => Promise<import('./transcript-tools').TranscriptSearchResult>;
  correctTurn: (input: import('./transcript-tools').CorrectTurnInput) => Promise<ActionResult>;
  undoTurnCorrection: (input: import('./transcript-tools').TurnCorrectionInput) => Promise<ActionResult>;
  resetTurnCorrection: (input: import('./transcript-tools').TurnCorrectionInput) => Promise<ActionResult>;
  addBookmark: (input: import('./transcript-tools').AddBookmarkInput) => Promise<ActionResult>;
  deleteBookmark: (input: import('./transcript-tools').DeleteBookmarkInput) => Promise<ActionResult>;
  hotwordStatus: () => Promise<import('./hotwords').HotwordStatus>;
  saveHotwords: (text: string) => Promise<import('./hotwords').HotwordStatus>;
  syncHotwords: () => Promise<import('./hotwords').HotwordStatus>;
  usageSummary: (period?: 'today' | 'month' | 'all') => Promise<import('./usage').UsageSummary>;
  openBilling: () => Promise<void>;
  importAudio: () => Promise<{ ok: true; canceled?: boolean; sessionId?: string } | { ok: false; error: string }>;
  cancelAudioImport: () => Promise<void>;
  setPlaybackRate: (rate: number) => Promise<ActionResult>;
  dictationSnapshot: () => Promise<import('./dictation').DictationState>;
  onDictation: (fn: (state: import('./dictation').DictationState) => void) => () => void;
  beginDictation: () => Promise<ActionResult>;
  endDictation: () => Promise<void>;
  cancelDictation: () => Promise<void>;
  retryDictation: () => Promise<ActionResult>;
  insertDictation: () => Promise<ActionResult>;
  copyDictation: () => Promise<ActionResult>;
  setShortcutCapture: (active: boolean) => Promise<ActionResult>;
  saveShortcuts: (input: import('./dictation').ShortcutPrefs) => Promise<ActionResult>;
  requestAccessibility: () => Promise<void>;
  snapshot: () => Promise<AppSnapshot>;
  saveKey: (key: string) => Promise<SaveKeyResult>;
  requestMic: () => Promise<ActionResult>;
  requestScreen: () => Promise<ActionResult>;
  openPrivacy: (pane: PrivacyPane) => Promise<void>;
  openKeyPage: () => Promise<void>;
  start: () => Promise<ActionResult>;
  stop: () => Promise<ActionResult>;
  retryRealtime: () => Promise<ActionResult>;
  selectSession: (id: string) => Promise<void>;
  setAutoDiarize: (on: boolean) => Promise<void>;
  setSharedMicrophone: (on: boolean) => Promise<void>;
  renameSpeaker: (input: RenameSpeakerInput) => Promise<RenameSpeakerResult>;
  undoSpeakerRename: (id: string) => Promise<ActionResult>;
  renameSession: (input: RenameSessionInput) => Promise<ActionResult>;
  deleteSession: (id: string) => Promise<ActionResult>;
  undoDeleteSession: (id: string) => Promise<ActionResult>;
  revealSession: (id: string) => Promise<ActionResult>;
  retryJob: (input: RetryJobInput) => Promise<ActionResult>;
  cancelJob: (sessionId: string) => Promise<ActionResult>;
  hideGlance: () => Promise<void>;
  showGlance: () => Promise<void>;
  showLibrary: () => Promise<void>;
  playSession: (id: string) => Promise<ActionResult>;
  pausePlayback: (sessionId?: string) => Promise<ActionResult>;
  resumePlayback: () => Promise<ActionResult>;
  seekPlayback: (input: { sessionId: string; positionSec: number; resume?: boolean }) => Promise<ActionResult>;
  stopPlayback: () => Promise<ActionResult>;
  playbackHost: (ready: boolean) => Promise<void>;
  reportPlayback: (report: PlaybackReport) => void;
  onPlaybackCommand: (fn: (command: PlaybackCommand) => void) => () => void;
  exportTranscript: (input: ExportTranscriptInput) => Promise<ExportTranscriptResult>;
  revealExport: (id: string) => Promise<ActionResult>;
  onChange: (fn: () => void) => () => void;
};
