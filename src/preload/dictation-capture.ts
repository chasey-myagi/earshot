import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('dictationCapture', {
  onStart: (start: () => void) => ipcRenderer.once('dictation-capture:start', () => start()),
  failed: () => ipcRenderer.send('dictation-capture:failed'),
  pcm: (bytes: Uint8Array) => ipcRenderer.send('dictation-capture:pcm', bytes),
});
