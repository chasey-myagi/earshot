import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('dictationCapture', {
  ready: () => ipcRenderer.send('dictation-capture:ready'),
  failed: () => ipcRenderer.send('dictation-capture:failed'),
  pcm: (bytes: Uint8Array) => ipcRenderer.send('dictation-capture:pcm', bytes),
});
