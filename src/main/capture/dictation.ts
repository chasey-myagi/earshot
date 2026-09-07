import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { loadRendererPage, configureCapturePermissions } from '../windows/load';

/** A dedicated microphone-only renderer. It never creates a meeting or writes a WAV. */
export function startDictationCapture(opts: { signal: AbortSignal; pcm: (bytes: Buffer) => void; failed: () => void }): Promise<{ stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) { reject(new Error('Canceled')); return; }
    const win = new BrowserWindow({ show: false, width: 4, height: 4, skipTaskbar: true,
      webPreferences: { partition: 'dictation', preload: join(__dirname, '../preload/dictation-capture.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    configureCapturePermissions(win, 'dictation-capture.html');
    let stopped = false, ready = false;
    const timeout = setTimeout(() => finish(new Error('Microphone timeout')), 15000);
    const abort = () => finish(new Error('Canceled'));
    function cleanup() {
      clearTimeout(timeout); opts.signal.removeEventListener('abort', abort);
      ipcMain.removeListener('dictation-capture:ready', onReady);
      ipcMain.removeListener('dictation-capture:failed', onFailed);
      ipcMain.removeListener('dictation-capture:pcm', onPcm);
    }
    function finish(error?: Error) {
      if (stopped) return;
      stopped = true; cleanup();
      if (!win.isDestroyed()) win.destroy();
      if (!ready) reject(error ?? new Error('Canceled'));
    }
    function onReady(event: Electron.IpcMainEvent) {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || stopped || ready) return;
      ready = true; clearTimeout(timeout);
      resolve({ stop: async () => finish() });
    }
    function onFailed(event: Electron.IpcMainEvent) {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || stopped) return;
      const wasReady = ready; finish(new Error('Microphone unavailable'));
      if (wasReady) opts.failed();
    }
    function onPcm(event: Electron.IpcMainEvent, raw: unknown) {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || stopped || !ready || !(raw instanceof Uint8Array) || raw.byteLength > 16384 || raw.byteLength % 2) return;
      opts.pcm(Buffer.from(raw));
    }
    ipcMain.on('dictation-capture:ready', onReady); ipcMain.on('dictation-capture:failed', onFailed); ipcMain.on('dictation-capture:pcm', onPcm);
    opts.signal.addEventListener('abort', abort, { once: true });
    win.webContents.once('render-process-gone', () => { const notify = ready && !stopped; finish(new Error('Renderer closed')); if (notify) opts.failed(); });
    const loaded = loadRendererPage(win, 'dictation-capture.html');
    void loaded.catch(() => finish(new Error('Capture page unavailable')));
  });
}
