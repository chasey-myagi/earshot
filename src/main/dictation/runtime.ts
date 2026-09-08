import { clipboard, globalShortcut, ipcMain, powerMonitor, systemPreferences, shell } from 'electron';
import { createDictationController, type InputTarget } from './controller';
import { createShortcutSettings } from './shortcuts';
import { startDictationCapture, prepareDictationCapture, closePreparedDictationCapture } from '../capture/dictation';
import { startDictationStream } from '../providers/dictation-stream';
import { polishDictation } from '../providers/dictation-polish';
import { DEFAULT_MODELS } from '../../shared/model-settings';
import { electronAccelerator } from '../../shared/shortcuts';
import type { SessionStore } from '../store/sessions';
import { createDictationWindow } from '../windows/dictation';
import type { ActionResult } from '../../shared/types';

export type DictationBridge = { captureTarget: () => InputTarget | null; held: (key: string) => boolean; escape: () => boolean; failureReason?: () => string | null; copy?: (text: string) => Promise<void>; close?: () => Promise<void> };

export function createDictationRuntime(opts: {
  store: SessionStore; root: string; apiKey: () => string | null; meetingBusy: () => boolean;
  startMeeting: () => Promise<ActionResult>; showMeeting: () => void;
  stopPlayback: () => Promise<void>; changed: () => void;
  bridge?: DictationBridge;
}) {
  const hud = createDictationWindow();
  let poll: ReturnType<typeof setInterval> | undefined;
  let shortcutCaptureTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let screenPoint: InputTarget['screenPoint'];
  const warmCapture = () => { if (!closed && settings.snapshot().prefs.enabled) prepareDictationCapture(); else closePreparedDictationCapture(); };
  let held = false, pollBusy = false, previousPhase = 'idle';
  const controller = createDictationController({
    preflight: () => !settings.snapshot().prefs.enabled ? '请先在设置中开启语音输入' : opts.meetingBusy() ? '正在录制，请先停止录制再使用语音输入' : !opts.apiKey() ? '请先在 Earshot 设置中保存百炼 API 密钥'
      : systemPreferences.getMediaAccessStatus('microphone') !== 'granted' ? '请在 Earshot 设置中允许麦克风访问' : null,
    target: () => {
      const target = opts.bridge?.captureTarget() ?? null;
      screenPoint = target?.screenPoint ? { ...target.screenPoint } : undefined;
      return target;
    },
    targetFailure: () => opts.bridge?.failureReason?.() ?? null,
    preview: () => settings.snapshot().prefs.delivery === 'preview',
    capture: async input => {
      await opts.stopPlayback();
      if (input.signal.aborted) throw new Error('Canceled');
      try {
        const capture = await startDictationCapture(input);
        return { stop: async () => { try { await capture.stop(); } finally { warmCapture(); } } };
      } catch (error) { warmCapture(); throw error; }
    },
    stream: signal => startDictationStream({ apiKey: opts.apiKey() ?? '', model: (settings.snapshot().prefs.models ?? DEFAULT_MODELS).asr, signal }),
    transcribe: (pcm, signal) => { const stream = startDictationStream({ apiKey: opts.apiKey() ?? '', model: (settings.snapshot().prefs.models ?? DEFAULT_MODELS).asr, signal });
      for (let offset = 0; offset < pcm.length; offset += 3200) stream.send(pcm.subarray(offset, offset + 3200)); return stream.finish(); },
    complete: async (rawText, input) => {
      const models = settings.snapshot().prefs.models ?? DEFAULT_MODELS;
      let text = rawText, warning: string | undefined;
      // Persist the raw transcript before optional LLM work so failure or quit cannot lose recognized words.
      opts.store.saveDictation({ ...input, result: { text, rawText, asrModel: models.asr } }); opts.changed();
      if (models.polish !== 'off') {
        input.progress('正在整理文字…');
        try { text = await polishDictation({ apiKey: opts.apiKey() ?? '', text: rawText, model: models.polish, signal: input.signal }); }
        catch { if (input.signal.aborted) return rawText; warning = '整理未完成，使用原始转写'; }
        if (input.signal.aborted) return rawText;
        opts.store.saveDictation({ ...input, result: { text, rawText, asrModel: models.asr, ...(warning ? { warning } : { polishModel: models.polish }) } }); opts.changed();
      }
      return text;
    },
    changed: state => {
      if (state.phase === 'idle') screenPoint = undefined;
      if (!closed) hud.show(state, screenPoint);
      if (state.phase !== previousPhase) { previousPhase = state.phase; opts.changed(); }
      if (state.phase === 'idle') { clearInterval(poll); poll = undefined; held = false; }
    },
  });
  async function userCancel() {
    const point = screenPoint;
    const cleanup = controller.cancel(true);
    // cancel hides immediately; a later same-session paste warning must still
    // appear on the original work screen, even if the mouse has since moved.
    if (!closed && controller.busy()) screenPoint = point;
    await cleanup;
    if (controller.snapshot().phase === 'idle') screenPoint = undefined;
  }
  async function keyPressed() {
    if (held || controller.busy()) return;
    // Keep meeting recording available if the platform bridge is unavailable.
    if (!opts.bridge) { controller.explain('语音输入暂不可用，请重新打开 Earshot 后再试'); return; }
    held = true;
    const starting = controller.begin();
    // begin clears old result synchronously; start watching the physical release after that reset.
    held = true;
    clearInterval(poll);
    poll = setInterval(() => {
      if (pollBusy) return;
      pollBusy = true;
      try {
        if (opts.bridge!.escape()) { held = false; void userCancel(); return; }
        if (held && !opts.bridge!.held(settings.snapshot().prefs.dictation)) {
          held = false;
          void controller.end();
        }
      } catch { held = false; void controller.cancel(); }
      finally { pollBusy = false; }
    }, 20);
    await starting;
  }
  const settings = createShortcutSettings({ root: opts.root,
    register: (key, fn) => globalShortcut.register(electronAccelerator(key), fn), unregister: key => globalShortcut.unregister(electronAccelerator(key)),
    meeting: () => {
      if (opts.meetingBusy()) { opts.showMeeting(); return; }
      if (controller.busy()) return;
      void controller.cancel().then(() => opts.startMeeting()).then(result => { if (!result.ok) opts.showMeeting(); });
    },
    dictation: () => { void keyPressed(); },
  });
  function status() { return { ...settings.snapshot(), accessibility: systemPreferences.isTrustedAccessibilityClient(false), holdAvailable: Boolean(opts.bridge) }; }
  function suspend() { held = false; void controller.cancel(); }
  function register() {
    settings.start(); hud.prepare(); warmCapture();
    powerMonitor.on('suspend', suspend); powerMonitor.on('lock-screen', suspend);
    ipcMain.handle('app:dictationSnapshot', () => controller.snapshot());
    ipcMain.handle('app:beginDictation', () => controller.begin());
    ipcMain.handle('app:endDictation', () => controller.end());
    ipcMain.handle('app:cancelDictation', () => userCancel());
    ipcMain.handle('app:retryDictation', () => controller.retry());
    ipcMain.handle('app:insertDictation', () => controller.insert());
    ipcMain.handle('app:copyDictation', async (): Promise<ActionResult> => {
      const state = controller.snapshot(), sessionId = controller.sessionId();
      if (state.phase !== 'result' || !state.text) return { ok: false, error: '没有可复制的文字' };
      try {
        if (opts.bridge?.copy) await opts.bridge.copy(state.text); else clipboard.writeText(state.text);
        if (controller.sessionId() === sessionId && controller.snapshot().phase === 'result') await controller.cancel();
        return { ok: true };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : '复制未完成，请稍后再试' }; }
    });
    ipcMain.handle('app:setShortcutCapture', (_event, active: unknown): ActionResult => {
      if (typeof active !== 'boolean') return { ok: false, error: '无效设置' };
      if (controller.busy()) return { ok: false, error: '请先结束语音输入' };
      clearTimeout(shortcutCaptureTimer);
      if (active) { settings.pause(); shortcutCaptureTimer = setTimeout(() => { settings.start(); opts.changed(); }, 30000); }
      else { settings.start(); opts.changed(); }
      return { ok: true };
    });
    ipcMain.handle('app:saveShortcuts', async (_event, raw: unknown): Promise<ActionResult> => {
      if (controller.busy()) return { ok: false, error: '请先结束语音输入' };
      const result = settings.save(raw);
      if (result.ok) { await controller.cancel(); warmCapture(); }
      opts.changed(); return result;
    });
    ipcMain.handle('app:requestAccessibility', () => {
      systemPreferences.isTrustedAccessibilityClient(true);
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    });
  }
  let closing: Promise<void> | undefined;
  return {
    register, status, snapshot: controller.snapshot, busy: controller.busy, cancel: controller.cancel, sessionId: controller.sessionId,
    close: () => {
      if (closing) return closing;
      closed = true; closePreparedDictationCapture(); clearTimeout(shortcutCaptureTimer); settings.close();
      powerMonitor.removeListener('suspend', suspend); powerMonitor.removeListener('lock-screen', suspend); clearInterval(poll); hud.close();
      closing = controller.cancel().then(() => opts.bridge?.close?.()).finally(() => { closing = undefined; });
      return closing;
    },
  };
}
