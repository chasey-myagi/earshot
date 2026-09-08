import { randomUUID } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain, protocol, shell, systemPreferences } from "electron";

app.setName("Earshot");
protocol.registerSchemesAsPrivileged([{ scheme: "earshot-audio", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.commandLine.appendSwitch("disable-features", "HardwareMediaKeyHandling,MediaSessionService");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
console.log("[earshot] main", app.getAppPath());
console.log("[earshot] exec", process.execPath);
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ActionResult,
  AppSnapshot,
  ExportTranscriptResult,
  PrivacyPane,
  RenameSpeakerInput,
  RenameSpeakerResult,
  RenameSessionInput,
  RetryJobInput,
  RealtimeStatus,
  RealtimeConnectionDetail,
  SaveKeyResult,
  Track,
} from "../shared/types";
import { startBlockers, micRequestResult, type ProbePermissions } from "./capture/permissions";
import {
  probeScreenPermission,
  requestScreenPermission,
} from "./capture/screen";
import { mapMediaStatus } from "./capture/screen-status";
import { startCapture } from "./capture/runtime";
import {
  abortRecordingStart,
  cancelJob as cancelQueuedJob,
  finishRecordingJobs,
  queuePost,
  recoverStuckJobs,
  settleSession,
} from "./jobs/orchestrate";
import { readStoredKey, writeStoredKey } from "./store/key";
import { createLiveBuffer, persistLive } from "./live";
import { createPlaybackController } from "./playback";
import { createLiveTranscriber, type LiveTranscriber } from "./live-transcriber";
import { createRealtimeEventWriter } from "./realtime-events";
import { isSessionId, createSessionStore, type SessionStore } from "./store/sessions";
import { assembleSnapshot } from "./store/snapshot";
import { sessionHasWavBody } from "./store/wav";
import { createSpeakerNames } from "./speaker-names";
import { exportTranscript } from "./export";
import { createGlanceWindow } from "./windows/glance";
import { loadRenderer } from "./windows/load";
import { createLibraryWindow } from "./windows/library";
import { createWindowNavigation } from "./windows/navigation";
import { createDictationRuntime } from "./dictation/runtime";
import { createMacDictationBridge } from "./dictation/macos";
import { createSessionDeletion } from "./session-deletion";
import { createRecordingActions } from "./recording-actions";
import { createMenubar } from "./menubar";
import { configureHotwords, getHotwordStatus, saveHotwords, syncHotwords } from "./providers/hotwords";
import { configureUsage, getUsageSummary } from "./providers/usage";
import { importAudio, AUDIO_IMPORT_EXTENSIONS } from "./import-audio";
import { decodeWithChromium } from "./import-audio-electron";

const PRIVACY: Record<PrivacyPane, string> = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
};

type LiveRec = { sessionId: string; startedAt: string; stoppedAt?: string; startupFailed?: boolean; exitCode: number | null;
  pendingLiveStatus?: "running" | "failed"; storageWarning?: string };

let dictation: ReturnType<typeof createDictationRuntime>;
let store: SessionStore;
let deletion: ReturnType<typeof createSessionDeletion>;
let speakerNames: ReturnType<typeof createSpeakerNames>;
let permissions: ProbePermissions = { microphone: "undetermined", screen: "undetermined" };
let live: LiveRec | null = null;
let selectedId: string | null = null;
let library: BrowserWindow | null = null;
let glance: BrowserWindow | null = null;
let capture: { stop: () => Promise<void> } | null = null;
let quitting = false;
let quitReady = false;
let libraryRequest = 0;
let settingsRequest = 0;
let menubar: ReturnType<typeof createMenubar> | undefined;
let audioImport: AppSnapshot['audioImport'];
let importAbort: AbortController | undefined;
let importPending: Promise<unknown> | undefined;
let transcriber: LiveTranscriber | null = null;
let realtimeStatus: RealtimeStatus = "connecting";
let realtimeConnectionDetail: RealtimeConnectionDetail | undefined;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
const liveBuf = createLiveBuffer();
const playback = createPlaybackController({
  send: command => {
    if (!library || library.isDestroyed()) throw new Error("Playback window unavailable");
    library.webContents.send("earshot:playback", command);
  },
  onChange: broadcast,
});
const jobPending = new Map<string, Promise<void>>();
const jobsInFlight = new Set<string>();
const jobAbort = new Map<string, AbortController>();
const jobFailReasons = new Map<string, { refined?: string; speakers?: string }>();

const KEY_PAGE = "https://bailian.console.aliyun.com/?tab=model#/api-key";

function supportDir(): string {
  return join(app.getPath("appData"), "Earshot");
}

function glanceIsVisible(): boolean {
  return glance !== null && !glance.isDestroyed() && glance.isVisible();
}

function readApiKey(): string | null {
  return readStoredKey(supportDir());
}

function snapshot(): AppSnapshot {
  return { ...assembleSnapshot(store, {
    hasApiKey: Boolean(readApiKey()),
    permissions,
    playingSessionId: playback.snapshot()?.sessionId ?? null,
    playback: playback.snapshot(),
    capturePhase: recordingActions.phase(),
    recording: live
      ? {
          sessionId: live.sessionId,
          startedAt: live.startedAt,
          stoppedAt: live.stoppedAt,
          glanceVisible: glanceIsVisible(),
          turns: liveBuf.turns(),
          connection: realtimeStatus,
          connectionDetail: realtimeConnectionDetail,
          storageWarning: live.storageWarning,
        }
      : null,
    selectedId,
    libraryRequest,
    jobFailReasons,
  }), audioImport, settingsRequest, deletions: deletion?.snapshot() ?? [], dictation: dictation?.snapshot(), shortcuts: dictation?.status() };
}

function broadcast(): void {
  menubar?.update(recordingActions.phase(), Boolean(audioImport) || Boolean(dictation?.busy()), dictation?.status());
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("earshot:changed");
  }
}

function broadcastSoon(): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcast();
  }, 80);
}

function stopRealtime(): void {
  transcriber?.stop();
  transcriber = null;
}

function saveLiveStatus(current: LiveRec): void {
  if (!current.pendingLiveStatus) return;
  if (!store.patchJobs(current.sessionId, { live: current.pendingLiveStatus })) throw new Error("找不到待保存的会话");
  current.pendingLiveStatus = undefined;
  current.storageWarning = undefined;
}

function startRealtime(apiKey: string, sessionId: string): void {
  transcriber = createLiveTranscriber({
      apiKey,
      onSentence: (track, sentence) => {
        if (!live || live.sessionId !== sessionId) return;
        const committed = liveBuf.apply(track, sentence, store.readSession(sessionId)?.sharedMicrophone);
        if (committed) persistLive(store.sessionDir(sessionId), committed);
        broadcastSoon();
      },
      onEvent: createRealtimeEventWriter(store.sessionDir(sessionId)),
      onTrackLost: track => { if (live?.sessionId === sessionId) liveBuf.clearPartials(track); },
      onStatus: (status, detail) => {
        if (!live || live.sessionId !== sessionId) return;
        realtimeStatus = status;
        realtimeConnectionDetail = detail;
        if (status === "connected" || status === "disconnected" || status === "reconnecting") {
          live.pendingLiveStatus = status === "connected" ? "running" : "failed";
          try { saveLiveStatus(live); }
          catch { live.storageWarning = "连接状态暂未保存。录音仍在继续，停止时可重试保存。"; }
        }
        broadcast();
      },
  });
}

function postQueue() {
  return {
    store,
    jobsInFlight,
    pending: jobPending,
    jobAbort,
    jobFailReasons,
    apiKey: readApiKey(),
    onChange: broadcast,
  };
}

function enqueuePost(sessionId: string, mode: "all" | "refined" | "speakers", userRetry = false): ActionResult {
  if (deletion?.blocked(sessionId)) return { ok: false, error: "会话正在删除" };
  const result = queuePost(postQueue(), sessionId, mode, userRetry);
  if (result.ok) speakerNames.invalidate(sessionId);
  return result;
}

function cancelJob(sessionId: string): ActionResult {
  return cancelQueuedJob(postQueue(), sessionId);
}

async function refreshPermissions(): Promise<void> {
  permissions = {
    microphone: mapMediaStatus(systemPreferences.getMediaAccessStatus("microphone")),
    screen: probeScreenPermission(),
  };
}

function attachLibrary(win: BrowserWindow): void {
  win.webContents.on("did-start-loading", () => playback.hostClosed());
  win.webContents.on("render-process-gone", () => playback.hostClosed());
  win.on("close", (event) => {
    if (!navigation.closeLibrary(quitting)) event.preventDefault();
    broadcast();
  });
  win.on("closed", () => {
    if (library === win) { playback.hostClosed(); library = null; }
  });
}

function openLibrary(): BrowserWindow {
  const win = createLibraryWindow();
  attachLibrary(win);
  win.webContents.on("preload-error", (_event, path, err) => {
    console.error("[earshot] preload-error", path, err);
  });
  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    console.error("[earshot] fail-load", code, desc, url);
  });
  win.webContents.on("did-finish-load", () => {
    console.log("[earshot] loaded", win.webContents.getURL());
  });
  loadRenderer(win);
  win.center();
  win.show();
  win.focus();
  return win;
}

function closeGlance(): void {
  if (glance && !glance.isDestroyed()) glance.close();
  glance = null;
}

function ensureGlanceWindow(): BrowserWindow | null {
  if (!live) return null;
  if (glance && !glance.isDestroyed()) {
    return glance;
  }
  const win = createGlanceWindow();
  glance = win;
  win.on("closed", () => {
    if (glance === win) glance = null;
    broadcast();
  });
  loadRenderer(win, "glance");
  return win;
}

const navigation = createWindowNavigation({
  library: () => {
    if (!library || library.isDestroyed()) library = openLibrary();
    return library;
  },
  glance: (create) => create ? ensureGlanceWindow() : glance && !glance.isDestroyed() ? glance : null,
  recordingId: () => live?.sessionId ?? null,
  select: (id) => { selectedId = id; },
  opened: () => { libraryRequest += 1; },
});

function revealFromDock(): void { navigation.openLibrary(); }

function cleanupFailedStart(current: LiveRec): void {
  abortRecordingStart({
    store, sessionId: current.sessionId, stoppedAt: current.stoppedAt, stopRealtime,
    clearLive: () => {
      live = null;
      liveBuf.reset();
      selectedId = store.readSession(current.sessionId) ? current.sessionId : store.listSummaries()[0]?.id ?? null;
      closeGlance();
      if (!quitting) navigation.openLibrary();
      broadcast();
    },
  });
}

async function finishRecording(
  reason: "stop" | "crash" | "quit",
  code?: number | null,
): Promise<void> {
  if (!live) return;
  const current = live;
  if (current.startupFailed) { cleanupFailedStart(current); return; }
  if (code !== undefined && code !== 0) current.exitCode = code;
  try {
    if (capture) await capture.stop();
  } catch (err) {
    if (current.exitCode === 0) current.exitCode = 1;
    console.error("[earshot] capture stop failed", err);
  } finally {
    current.stoppedAt ??= new Date().toISOString();
    capture = null;
    stopRealtime();
    saveLiveStatus(current);
    settleSession(store, current.sessionId, current.startedAt, current.exitCode, current.stoppedAt);
    // A quit can arrive while a manual stop is awaiting capture. Persist every
    // shutdown step before releasing the recovery owner, and never enqueue then.
    const effectiveReason = quitting ? "quit" : reason;
    finishRecordingJobs(postQueue(), current.sessionId, effectiveReason);
    live = null;
    liveBuf.reset();
    selectedId = current.sessionId;
    closeGlance();
    if (effectiveReason !== "quit") navigation.openLibrary();
    broadcast();
  }
}

async function onCaptureCrash(): Promise<void> {
  if (live) live.exitCode = 1;
  await recordingActions.stop("crash");
}

async function startRecording(): Promise<ActionResult> {
  if (quitting || audioImport) return { ok: false, error: "请先完成音频导入", code: "busy" };
  if (dictation?.busy()) return { ok: false, error: "请先结束语音输入", code: "busy" };
  if (dictation && dictation.snapshot().phase !== "idle") await dictation.cancel();
  const apiKey = readApiKey();
  await refreshPermissions();
  const blocked = startBlockers({
    busy: live !== null,
    hasApiKey: Boolean(apiKey),
    permissions,
  });
  if (blocked) return blocked;
  if (!apiKey) return { ok: false, error: "没有密钥不能开始", code: "no_key" };

  try { await playback.stopAndWait(); }
  catch { return { ok: false, error: "回听尚未停止，请关闭回听后重试录音" }; }

  const doc = store.createRecording();
  live = { sessionId: doc.id, startedAt: doc.startedAt, exitCode: 0 };
  selectedId = doc.id;
  liveBuf.reset();
  try {
    startRealtime(apiKey, doc.id);
    capture = await startCapture({
      destDir: store.sessionDir(doc.id),
      onPcm: (track, pcm) => {
        transcriber?.sendPcm(track, pcm);
      },
      onCrash: () => {
        void onCaptureCrash();
      },
    });
  } catch (err) {
    live.startupFailed = true;
    live.exitCode = 1;
    live.stoppedAt = new Date().toISOString();
    cleanupFailedStart(live);
    const error = err instanceof Error && err.message ? err.message : "采集没起来";
    const code = error.includes("麦克风") ? "no_mic" : "no_screen";
    return { ok: false, error, code };
  }
  if (!quitting) navigation.showGlance();
  broadcast();
  return { ok: true };
}

const recordingActions = createRecordingActions({
  start: startRecording,
  hasUnfinished: () => live !== null,
  finish: reason => finishRecording(reason, reason === "crash" ? 1 : 0),
  onChange: broadcast,
});

function registerIpc(): void {
  ipcMain.handle("app:snapshot", (): AppSnapshot => snapshot());

  ipcMain.handle("app:searchTranscripts", (_event, raw: unknown) => store.searchTranscripts(raw));
  for (const action of ['correctTurn', 'undoTurnCorrection', 'resetTurnCorrection', 'addBookmark', 'deleteBookmark'] as const) {
    ipcMain.handle(`app:${action}`, (_event, raw: unknown): ActionResult => {
      const id = raw && typeof raw === 'object' ? (raw as { sessionId?: unknown }).sessionId : undefined;
      if (!isSessionId(id)) return { ok: false, error: '找不到这场会' };
      if (deletion.blocked(id)) return { ok: false, error: '会话正在删除' };
      if (id === live?.sessionId && action !== 'addBookmark' && action !== 'deleteBookmark') return { ok: false, error: '停止录音并保存后即可修改' };
      const result = store[action](raw);
      if (result.ok) broadcast();
      return result;
    });
  }
  ipcMain.handle('app:hotwordStatus', () => getHotwordStatus());
  ipcMain.handle('app:saveHotwords', async (_event, raw: unknown) => { const result = await saveHotwords(raw); broadcast(); return result; });
  ipcMain.handle('app:syncHotwords', async () => { const result = await syncHotwords(); broadcast(); return result; });
  ipcMain.handle('app:usageSummary', (_event, period: unknown) => getUsageSummary(period === 'today' || period === 'all' ? period : 'month'));
  ipcMain.handle('app:openBilling', async () => { await shell.openExternal('https://usercenter2.aliyun.com/finance/'); });
  ipcMain.handle('app:importAudio', (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent || parent !== library || parent.isDestroyed()) return { ok: false, error: '请在会话窗口中导入音频' };
    if (quitting || audioImport || recordingActions.phase() !== 'idle' || dictation?.busy()) return { ok: false, error: '请先完成当前录音、语音输入或导入', code: 'busy' };
    const controller = new AbortController();
    importAbort = controller;
    audioImport = { phase: 'choosing', message: '选择要导入的音频' }; broadcast();
    const pending = (async () => {
      try {
        const picked = await dialog.showOpenDialog(parent, { title: '导入音频', buttonLabel: '导入', properties: ['openFile'], filters: [{ name: '音频', extensions: [...AUDIO_IMPORT_EXTENSIONS] }] });
        if (picked.canceled || controller.signal.aborted || !picked.filePaths[0]) return { ok: true as const, canceled: true };
        const result = await importAudio({
          sourcePath: picked.filePaths[0], sessionsRoot: join(store.rootDir, 'sessions'), decode: decodeWithChromium, signal: controller.signal,
          onProgress: progress => {
            audioImport = { phase: progress.phase === 'saving' ? 'saving' : 'decoding', percent: progress.percent,
              message: progress.phase === 'copying' ? '正在复制音频' : progress.phase === 'decoding' ? '正在解码音频' : '正在保存会话' };
            broadcastSoon();
          },
          commit: result => {
            const now = new Date().toISOString();
            store.writeSession({ schema_version: 1, id: result.id, title: result.title, startedAt: now, endedAt: now,
              durationSec: result.durationSec, status: 'complete', autoDiarize: store.readPrefs().autoDiarize,
              audio: { sampleRate: 16000, channels: 1, codec: 'pcm_s16le' }, tracks: { microphone: false, system: true },
              jobs: { live: 'idle', refined: { status: 'idle', current: null }, speakers: { status: 'idle', current: null } } });
          },
        });
        selectedId = result.id;
        if (readApiKey()) enqueuePost(result.id, 'all');
        else store.patchJobs(result.id, { refined: { status: 'failed', reason: '音频已保存；请先设置百炼 API 密钥，再重试转写' } });
        return { ok: true as const, sessionId: result.id };
      } catch (error) {
        return controller.signal.aborted ? { ok: true as const, canceled: true } : { ok: false as const, error: error instanceof Error ? error.message : '音频导入失败，请重试' };
      } finally {
        audioImport = undefined; importAbort = undefined; importPending = undefined; broadcast();
      }
    })();
    importPending = pending;
    return pending;
  });
  ipcMain.handle('app:cancelAudioImport', () => { importAbort?.abort(); });

  ipcMain.handle("app:renameSession", (_event, raw: unknown): ActionResult => {
    if (raw && typeof raw === "object" && (raw as RenameSessionInput).sessionId === live?.sessionId) {
      return { ok: false, error: "停止录音并保存后即可改名" };
    }
    if (raw && typeof raw === "object" && deletion.blocked((raw as RenameSessionInput).sessionId)) return { ok: false, error: "会话正在删除" };
    const result = store.renameSession(raw);
    if (result.ok) {
      broadcast();
    }
    return result;
  });

  const deletionDialogs = new Set<string>();
  ipcMain.handle("app:deleteSession", async (event, id: unknown): Promise<ActionResult> => {
    if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return { ok: false, error: "找不到这场会" };
    const doc = store.readSession(id);
    if (!doc) return { ok: false, error: "找不到这场会" };
    if (doc.status === "recording" || live?.sessionId === id) return { ok: false, error: "请先停止录制并保存" };
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!parent || parent !== library || deletionDialogs.has(id)) return { ok: false, error: "请先完成当前删除确认" };
    deletionDialogs.add(id);
    try {
      const answer = await dialog.showMessageBox(parent, {
        type: "warning", buttons: ["取消", "删除会话"], defaultId: 0, cancelId: 0,
        message: `删除「${doc.title}」？`,
        detail: "录音与转录一起删除，已记住的人物保留。后台任务将停止，8 秒撤销期后移到系统废纸篓。已导出的副本不受影响。",
        noLink: true,
      });
      return answer.response === 1 ? await deletion.remove(id) : { ok: true };
    } catch { return { ok: false, error: "删除没有完成，请重试" }; }
    finally { deletionDialogs.delete(id); }
  });
  ipcMain.handle("app:undoDeleteSession", (_event, id: unknown): ActionResult => deletion.undo(id));
  ipcMain.handle("app:revealSession", (_event, id: unknown): ActionResult => {
    if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !store.readSession(id)) return { ok: false, error: "找不到这场会" };
    shell.showItemInFolder(store.sessionDir(id));
    return { ok: true };
  });

  const exportedFiles = new Map<string, string>();
  ipcMain.handle("app:revealExport", (_event, id: unknown): ActionResult => {
    const path = typeof id === "string" ? exportedFiles.get(id) : undefined;
    if (!path) return { ok: false, error: "这个导出位置已失效，请重新导出" };
    try { shell.showItemInFolder(path); return { ok: true }; }
    catch { return { ok: false, error: "无法打开文件位置，请在 Finder 中查找" }; }
  });
  let exportPending = false;
  ipcMain.handle("app:exportTranscript", async (event, raw: unknown): Promise<ExportTranscriptResult> => {
    if (exportPending) return { ok: false, error: "请先完成当前导出" };
    exportPending = true;
    try {
      let saved: { id: string; path: string } | undefined;
      const result = await exportTranscript(store, raw, async (filename, format) => {
        const parent = BrowserWindow.fromWebContents(event.sender);
        if (!parent || parent.isDestroyed()) throw new Error("会话窗口已关闭");
        const result = await dialog.showSaveDialog(parent, {
          title: "导出转录文本",
          buttonLabel: "导出",
          defaultPath: join(app.getPath("downloads"), filename),
          filters: [{ name: format === "txt" ? "纯文本" : "JSON", extensions: [format] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });
        return result.canceled ? null : result.filePath ?? null;
      }, path => {
        const id = randomUUID();
        exportedFiles.set(id, path);
        if (exportedFiles.size > 8) exportedFiles.delete(exportedFiles.keys().next().value!);
        saved = { id, path };
      });
      return result.ok && saved ? { ...result, saved } : result;
    } finally {
      exportPending = false;
    }
  });

  ipcMain.handle("app:saveKey", (_event, raw: unknown): SaveKeyResult => {
    if (typeof raw !== "string" || raw.trim().length < 8) {
      return { ok: false, error: "密钥看起来不完整" };
    }
    try {
      writeStoredKey(supportDir(), raw);
    } catch (err) {
      return { ok: false, error: "密钥没保存，请检查磁盘空间后重试" };
    }
    void syncHotwords().then(broadcast).catch(() => broadcast());
    broadcast();
    return { ok: true };
  });

  ipcMain.handle("app:requestMic", async (): Promise<ActionResult> => {
    let granted = false;
    try {
      granted = await systemPreferences.askForMediaAccess("microphone");
    } catch {
      granted = false;
    }
    const result = micRequestResult(granted);
    await refreshPermissions();
    broadcast();
    return result;
  });

  ipcMain.handle("app:requestScreen", async (): Promise<ActionResult> => {
    const result = await requestScreenPermission();
    await refreshPermissions();
    broadcast();
    return result;
  });

  ipcMain.handle("app:openPrivacy", (_event, pane: unknown): void => {
    if (pane !== "microphone" && pane !== "screen") return;
    void shell.openExternal(PRIVACY[pane]);
  });

  ipcMain.handle("app:openKeyPage", (): void => {
    void shell.openExternal(KEY_PAGE);
  });

  ipcMain.handle("app:start", (): Promise<ActionResult> => recordingActions.start());

  ipcMain.handle("app:stop", async (): Promise<ActionResult> => {
    return recordingActions.stop("stop");
  });

  ipcMain.handle("app:retryRealtime", (): ActionResult => {
    if (recordingActions.phase() !== "recording" || !live || !transcriber?.retry()) {
      return { ok: false, error: "当前不需要重连" };
    }
    return { ok: true };
  });

  ipcMain.handle("app:selectSession", (_event, id: unknown): void => {
    if (isSessionId(id)) selectedId = id;
    broadcast();
  });

  ipcMain.handle("app:setAutoDiarize", (_event, on: unknown): void => {
    if (typeof on !== "boolean") return;
    store.setAutoDiarize(on);
    broadcast();
  });
  ipcMain.handle("app:setSharedMicrophone", (_event, on: unknown): void => {
    if (typeof on !== "boolean") return;
    store.setSharedMicrophone(on);
    broadcast();
  });

  ipcMain.handle("app:renameSpeaker", (_event, raw: unknown): RenameSpeakerResult => {
    if (!raw || typeof raw !== "object") return { ok: false, error: "改不了这个名字" };
    const input = raw as RenameSpeakerInput;
    if (!isSessionId(input.sessionId) || typeof input.from !== "string" || typeof input.to !== "string") {
      return { ok: false, error: "改不了这个名字" };
    }
    if (input.sessionId === live?.sessionId) return { ok: false, error: "停止录音后即可起名" };
    if (deletion.blocked(input.sessionId)) return { ok: false, error: "会话正在删除" };
    const result = speakerNames.rename(input);
    broadcast();
    return result;
  });

  ipcMain.handle("app:undoSpeakerRename", (_event, id: unknown): ActionResult => {
    if (typeof id !== "string") return { ok: false, error: "撤销不了这次改名" };
    const result = speakerNames.undo(id);
    broadcast();
    return result;
  });

  ipcMain.handle("app:retryJob", (_event, raw: unknown): ActionResult => {
    if (!raw || typeof raw !== "object") return { ok: false, error: "重试不了" };
    const input = raw as RetryJobInput;
    if (!isSessionId(input.sessionId) || (input.job !== "refined" && input.job !== "speakers")) {
      return { ok: false, error: "重试不了" };
    }
    return enqueuePost(input.sessionId, input.job, true);
  });

  ipcMain.handle("app:cancelJob", (_event, id: unknown): ActionResult => {
    if (!isSessionId(id)) return { ok: false, error: "取消不了" };
    return cancelJob(id);
  });

  ipcMain.handle("app:hideGlance", (): void => {
    navigation.hideGlance();
    broadcast();
  });

  ipcMain.handle("app:showGlance", (): void => {
    navigation.showGlance();
    broadcast();
  });

  ipcMain.handle("app:showLibrary", (): void => {
    navigation.openLibrary();
    broadcast();
  });

  ipcMain.handle("app:playbackHost", (event, ready: unknown): void => {
    if (event.sender !== library?.webContents) return;
    if (ready === true) playback.hostReady();
    else if (ready === false) playback.hostClosed();
  });
  ipcMain.on("app:playbackReport", (event, report: unknown): void => {
    if (event.sender === library?.webContents) playback.report(report);
  });
  function playbackBlocked(): ActionResult | null {
    return live || recordingActions.phase() !== "idle" || dictation?.busy()
      ? { ok: false, error: "录音中不能回听，避免把播放录入本场", code: "busy" } : null;
  }
  function playbackDocument(id: unknown) {
    if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return null;
    if (deletion.blocked(id)) return null;
    const doc = store.readSession(id);
    return doc && doc.status !== "recording" ? doc : null;
  }
  ipcMain.handle("app:playSession", (_event, id: unknown): ActionResult | Promise<ActionResult> => {
    const blocked = playbackBlocked(); if (blocked) return blocked;
    const doc = playbackDocument(id);
    if (!doc) return { ok: false, error: "找不到可回听的会话" };
    return playback.play(store.sessionDir(doc.id), doc.id, doc.title);
  });
  ipcMain.handle("app:pausePlayback", (_event, id?: unknown): ActionResult | Promise<ActionResult> => {
    const blocked = playbackBlocked(); if (blocked) return blocked;
    if (id !== undefined && typeof id !== "string") return { ok: false, error: "无效的回听会话" };
    return playback.pause(id);
  });
  ipcMain.handle('app:setPlaybackRate', (_event, rate: unknown): ActionResult | Promise<ActionResult> => playbackBlocked() ?? (typeof rate === 'number' ? playback.setRate(rate) : { ok: false, error: '无效的播放速度' }));
  ipcMain.handle("app:resumePlayback", (): ActionResult | Promise<ActionResult> => playbackBlocked() ?? playback.resume());
  ipcMain.handle("app:seekPlayback", (_event, raw: unknown): ActionResult | Promise<ActionResult> => {
    const blocked = playbackBlocked(); if (blocked) return blocked;
    if (!raw || typeof raw !== "object") return { ok: false, error: "无效的回听位置" };
    const input = raw as { sessionId?: unknown; positionSec?: unknown; resume?: unknown };
    if (typeof input.positionSec !== "number" || !Number.isFinite(input.positionSec) || input.positionSec < 0 ||
        (input.resume !== undefined && typeof input.resume !== "boolean")) return { ok: false, error: "无效的回听位置" };
    const doc = playbackDocument(input.sessionId);
    if (!doc) return { ok: false, error: "找不到可回听的会话" };
    return playback.seekSession(store.sessionDir(doc.id), doc.id, doc.title, input.positionSec, input.resume === true);
  });
  ipcMain.handle("app:stopPlayback", async (): Promise<ActionResult> => {
    try { await playback.stopAndWait(); return { ok: true }; }
    catch { return { ok: false, error: "回听尚未停止，请重试" }; }
  });
}

app.on("open-file", (event) => {
  event.preventDefault();
  if (!app.isReady()) return;
  void refreshPermissions().then(() => {
    revealFromDock();
    broadcast();
  });
});

app.whenReady().then(async () => {
  try {
    app.dock?.setIcon(join(process.resourcesPath, "earshot-icon.png"));
    mkdirSync(join(supportDir(), "sessions"), { recursive: true });
    store = createSessionStore(supportDir());
    configureHotwords(join(supportDir(), 'hotwords.json'), readApiKey);
    configureUsage(join(supportDir(), 'usage.json'));
    speakerNames = createSpeakerNames({ store, onChange: broadcast });
    deletion = createSessionDeletion({
      store,
      active: id => live?.sessionId === id,
      quiesce: async id => {
        if (dictation?.sessionId() === id) await dictation.cancel();
        speakerNames.invalidate(id);
        jobAbort.get(id)?.abort();
        await jobPending.get(id);
        if (playback.snapshot()?.sessionId === id) await playback.stopAndWait();
        jobFailReasons.delete(id);
      },
      trash: path => shell.trashItem(path),
      changed: (id, restored, nextId) => {
        if (restored) selectedId = id;
        else if (selectedId === id && !store.readSession(id)) selectedId = (nextId && store.readSession(nextId) ? nextId : store.listSummaries()[0]?.id) ?? null;
        broadcast();
      },
    });
    deletion.recover();
    const orphanIds = store.recoverOrphans();
    selectedId = store.listSummaries()[0]?.id ?? null;
    protocol.handle("earshot-audio", request => playback.respond(request));
    dictation = createDictationRuntime({
      bridge: createMacDictationBridge(),
      store, root: supportDir(), apiKey: readApiKey,
      meetingBusy: () => recordingActions.phase() !== 'idle' || Boolean(audioImport) || quitting,
      startMeeting: () => recordingActions.start(),
      showMeeting: () => { navigation.openLibrary(); broadcast(); },
      stopPlayback: () => playback.stopAndWait(), changed: broadcast,
    });
    registerIpc();
    dictation.register();
    library = openLibrary();
    menubar = createMenubar({
      open: () => { navigation.openLibrary(); broadcast(); },
      settings: () => { settingsRequest += 1; navigation.openLibrary(); broadcast(); },
      start: () => { void recordingActions.start().then(result => { if (!result.ok) { navigation.openLibrary(); dialog.showErrorBox('录音未开始', result.error); } }); },
      stop: () => { void recordingActions.stop('stop').then(result => { if (!result.ok) { navigation.openLibrary(); dialog.showErrorBox('录音尚未保存', result.error); } }); },
      quit: () => app.quit(),
    });
    if (getHotwordStatus().words.length && readApiKey()) void syncHotwords().then(broadcast).catch(() => broadcast());
    console.log("[earshot] library window");
    await refreshPermissions();
    recoverStuckJobs(postQueue());
    for (const id of orphanIds) {
      if (sessionHasWavBody(store.sessionDir(id))) void enqueuePost(id, "all");
    }
    broadcast();
  } catch (err) {
    console.error("[earshot] ready failed", err);
  }
});

app.on("activate", () => {
  void refreshPermissions().then(() => {
    revealFromDock();
    broadcast();
  });
});

app.on("before-quit", (event) => {
  if (quitReady) return;
  if (quitting) { event.preventDefault(); return; }
  quitting = true;
  speakerNames?.close();
  importAbort?.abort();
  event.preventDefault();
  void Promise.all([recordingActions.stop("quit"), importPending]).then(async ([result]) => {
    if (!result.ok && recordingActions.phase() !== "idle") {
      quitting = false;
      navigation.openLibrary();
      dialog.showErrorBox("录音尚未保存完成", "无法完成收尾，请检查存储空间后重新停止录制。Earshot 将保持打开。");
      return;
    }
    try { await dictation?.close(); await playback.stopAndWait(); }
    catch {
      quitting = false;
      dialog.showErrorBox("收尾尚未完成", "剪贴板或播放仍在收尾。Earshot 将保持打开，请稍后再退出。");
      return;
    }
    menubar?.close(); deletion?.close();
    quitReady = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  // macOS Dock can reopen the hidden library; only an explicit quit exits.
});
