import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { loadRendererPage, configureCapturePermissions } from '../windows/load';

type CapturePage = { win: BrowserWindow; loaded: Promise<void> };
let prepared: CapturePage | undefined;
function createPage(): CapturePage {
  const win = new BrowserWindow({ show: false, width: 4, height: 4, skipTaskbar: true,
      webPreferences: { partition: 'dictation', preload: join(__dirname, '../preload/dictation-capture.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  try {
    configureCapturePermissions(win, 'dictation-capture.html');
    return { win, loaded: loadRendererPage(win, 'dictation-capture.html') };
  } catch (error) { win.destroy(); throw error; }
}
/** Warm the renderer only. The page cannot request microphone access until start is sent. */
export function prepareDictationCapture(): void {
  if (prepared && !prepared.win.isDestroyed()) return;
  try {
    const page = createPage(); prepared = page;
    const discard = () => {
      if (prepared === page) prepared = undefined;
      if (!page.win.isDestroyed()) page.win.destroy();
    };
    void page.loaded.catch(discard);
    page.win.webContents.once('render-process-gone', discard);
  } catch { /* A failed warmup falls back to a fresh page on the next request. */ }
}
export function closePreparedDictationCapture(): void {
  const page = prepared; prepared = undefined;
  if (page && !page.win.isDestroyed()) page.win.destroy();
}

/** A dedicated microphone-only renderer. It never creates a meeting or writes a WAV. */
export function startDictationCapture(opts: { signal: AbortSignal; pcm: (bytes: Buffer) => void; failed: () => void }): Promise<{ stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) { reject(new Error('Canceled')); return; }
    const page = prepared && !prepared.win.isDestroyed() ? prepared : createPage();
    prepared = undefined;
    const { win } = page;
    let stopped = false, ready = false;
    const timeout = setTimeout(() => finish(new Error('Microphone timeout')), 15000);
    const abort = () => finish(new Error('Canceled'));
    function cleanup() {
      clearTimeout(timeout); opts.signal.removeEventListener('abort', abort);
      ipcMain.removeListener('dictation-capture:failed', onFailed);
      ipcMain.removeListener('dictation-capture:pcm', onPcm);
    }
    function finish(error?: Error) {
      if (stopped) return;
      stopped = true; cleanup();
      if (!win.isDestroyed()) win.destroy();
      if (!ready) reject(error ?? new Error('Canceled'));
    }
    function onFailed(event: Electron.IpcMainEvent) {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || stopped) return;
      const wasReady = ready; finish(new Error('Microphone unavailable'));
      if (wasReady) opts.failed();
    }
    function onPcm(event: Electron.IpcMainEvent, raw: unknown) {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || stopped || !(raw instanceof Uint8Array) || !raw.byteLength || raw.byteLength > 16384 || raw.byteLength % 2) return;
      if (!ready) {
        ready = true; clearTimeout(timeout);
        resolve({ stop: async () => finish() });
      }
      // The controller retains this first frame even while its await is resuming.
      opts.pcm(Buffer.from(raw));
    }
    ipcMain.on('dictation-capture:failed', onFailed); ipcMain.on('dictation-capture:pcm', onPcm);
    opts.signal.addEventListener('abort', abort, { once: true });
    win.webContents.once('render-process-gone', () => { const notify = ready && !stopped; finish(new Error('Renderer closed')); if (notify) opts.failed(); });
    void page.loaded.then(() => { if (!stopped && !win.isDestroyed()) win.webContents.send('dictation-capture:start'); }).catch(() => finish(new Error('Capture page unavailable')));
  });
}
