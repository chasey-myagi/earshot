import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("capture", {
  begin: (): Promise<{ sourceId: string }> => ipcRenderer.invoke("capture:begin"),
  ready: (): void => {
    ipcRenderer.send("capture:ready");
  },
  failed: (message: string): void => {
    ipcRenderer.send("capture:failed", message);
  },
  sendPcm: (track: string, pcm: Uint8Array): void => {
    ipcRenderer.send("capture:pcm", track, pcm);
  },
});
