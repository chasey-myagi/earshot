import { contextBridge, ipcRenderer } from "electron";
import type {
  ActionResult,
  AppSnapshot,
  EarshotApi,
  ExportTranscriptInput,
  ExportTranscriptResult,
  PrivacyPane,
  PlaybackCommand,
  PlaybackReport,
  RenameSpeakerInput,
  RenameSpeakerResult,
  RenameSessionInput,
  RetryJobInput,
  SaveKeyResult,
} from "../shared/types";

contextBridge.exposeInMainWorld("earshot", {
  searchTranscripts: input => ipcRenderer.invoke('app:searchTranscripts', input),
  correctTurn: input => ipcRenderer.invoke('app:correctTurn', input),
  undoTurnCorrection: input => ipcRenderer.invoke('app:undoTurnCorrection', input),
  resetTurnCorrection: input => ipcRenderer.invoke('app:resetTurnCorrection', input),
  addBookmark: input => ipcRenderer.invoke('app:addBookmark', input),
  deleteBookmark: input => ipcRenderer.invoke('app:deleteBookmark', input),
  hotwordStatus: () => ipcRenderer.invoke('app:hotwordStatus'),
  saveHotwords: text => ipcRenderer.invoke('app:saveHotwords', text),
  syncHotwords: () => ipcRenderer.invoke('app:syncHotwords'),
  usageSummary: period => ipcRenderer.invoke('app:usageSummary', period),
  openBilling: () => ipcRenderer.invoke('app:openBilling'),
  importAudio: () => ipcRenderer.invoke('app:importAudio'),
  cancelAudioImport: () => ipcRenderer.invoke('app:cancelAudioImport'),
  setPlaybackRate: rate => ipcRenderer.invoke('app:setPlaybackRate', rate),
  snapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke("app:snapshot"),
  saveKey: (key: string): Promise<SaveKeyResult> => ipcRenderer.invoke("app:saveKey", key),
  requestMic: (): Promise<ActionResult> => ipcRenderer.invoke("app:requestMic"),
  requestScreen: (): Promise<ActionResult> => ipcRenderer.invoke("app:requestScreen"),
  openPrivacy: (pane: PrivacyPane): Promise<void> => ipcRenderer.invoke("app:openPrivacy", pane),
  openKeyPage: (): Promise<void> => ipcRenderer.invoke("app:openKeyPage"),
  start: (): Promise<ActionResult> => ipcRenderer.invoke("app:start"),
  stop: (): Promise<ActionResult> => ipcRenderer.invoke("app:stop"),
  retryRealtime: (): Promise<ActionResult> => ipcRenderer.invoke("app:retryRealtime"),
  selectSession: (id: string): Promise<void> => ipcRenderer.invoke("app:selectSession", id),
  setAutoDiarize: (on: boolean): Promise<void> => ipcRenderer.invoke("app:setAutoDiarize", on),
  setSharedMicrophone: (on: boolean): Promise<void> => ipcRenderer.invoke("app:setSharedMicrophone", on),
  renameSpeaker: (input: RenameSpeakerInput): Promise<RenameSpeakerResult> =>
    ipcRenderer.invoke("app:renameSpeaker", input),
  undoSpeakerRename: (id: string): Promise<ActionResult> => ipcRenderer.invoke("app:undoSpeakerRename", id),
  renameSession: (input: RenameSessionInput): Promise<ActionResult> =>
    ipcRenderer.invoke("app:renameSession", input),
  retryJob: (input: RetryJobInput): Promise<ActionResult> => ipcRenderer.invoke("app:retryJob", input),
  cancelJob: (sessionId: string): Promise<ActionResult> => ipcRenderer.invoke("app:cancelJob", sessionId),
  hideGlance: (): Promise<void> => ipcRenderer.invoke("app:hideGlance"),
  showGlance: (): Promise<void> => ipcRenderer.invoke("app:showGlance"),
  showLibrary: (): Promise<void> => ipcRenderer.invoke("app:showLibrary"),
  playSession: (id: string): Promise<ActionResult> => ipcRenderer.invoke("app:playSession", id),
  pausePlayback: (sessionId?: string): Promise<ActionResult> => ipcRenderer.invoke("app:pausePlayback", sessionId),
  resumePlayback: (): Promise<ActionResult> => ipcRenderer.invoke("app:resumePlayback"),
  seekPlayback: (input: { sessionId: string; positionSec: number; resume?: boolean }): Promise<ActionResult> => ipcRenderer.invoke("app:seekPlayback", input),
  stopPlayback: (): Promise<ActionResult> => ipcRenderer.invoke("app:stopPlayback"),
  playbackHost: (ready: boolean): Promise<void> => ipcRenderer.invoke("app:playbackHost", ready),
  reportPlayback: (report: PlaybackReport): void => ipcRenderer.send("app:playbackReport", report),
  onPlaybackCommand: (fn: (command: PlaybackCommand) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: PlaybackCommand) => fn(command);
    ipcRenderer.on("earshot:playback", listener);
    return () => ipcRenderer.removeListener("earshot:playback", listener);
  },
  dictationSnapshot: () => ipcRenderer.invoke('app:dictationSnapshot'),
  onDictation: (fn: (state: import('../shared/dictation').DictationState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: import('../shared/dictation').DictationState) => fn(state);
    ipcRenderer.on('earshot:dictation', listener);
    return () => ipcRenderer.removeListener('earshot:dictation', listener);
  },
  beginDictation: () => ipcRenderer.invoke('app:beginDictation'),
  endDictation: () => ipcRenderer.invoke('app:endDictation'),
  cancelDictation: () => ipcRenderer.invoke('app:cancelDictation'),
  retryDictation: () => ipcRenderer.invoke('app:retryDictation'),
  insertDictation: () => ipcRenderer.invoke('app:insertDictation'),
  copyDictation: () => ipcRenderer.invoke('app:copyDictation'),
  setShortcutCapture: active => ipcRenderer.invoke('app:setShortcutCapture', active),
  saveShortcuts: (input: import('../shared/dictation').ShortcutPrefs) => ipcRenderer.invoke('app:saveShortcuts', input),
  requestAccessibility: () => ipcRenderer.invoke('app:requestAccessibility'),
  deleteSession: (id: string): Promise<ActionResult> => ipcRenderer.invoke("app:deleteSession", id),
  undoDeleteSession: (id: string): Promise<ActionResult> => ipcRenderer.invoke("app:undoDeleteSession", id),
  revealSession: (id: string): Promise<ActionResult> => ipcRenderer.invoke("app:revealSession", id),
  revealExport: (id: string): Promise<ActionResult> => ipcRenderer.invoke("app:revealExport", id),
  exportTranscript: (input: ExportTranscriptInput): Promise<ExportTranscriptResult> =>
    ipcRenderer.invoke("app:exportTranscript", input),
  onChange: (fn: () => void): (() => void) => {
    const listener = (): void => {
      fn();
    };
    ipcRenderer.on("earshot:changed", listener);
    return () => ipcRenderer.removeListener("earshot:changed", listener);
  },
} satisfies EarshotApi);
