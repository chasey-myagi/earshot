import { BrowserWindow, desktopCapturer, ipcMain } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Track } from "../../shared/types";
import { createPcmWavWriter } from "../store/wav";
import { loadRendererPage, configureCapturePermissions } from "../windows/load";
import { noteScreenGranted } from "./screen";

function capturePreloadPath(): string {
  const dir = join(__dirname, "../preload");
  const cjs = join(dir, "capture.js");
  if (existsSync(cjs)) return cjs;
  const mjs = join(dir, "capture.mjs");
  return existsSync(mjs) ? mjs : cjs;
}

function loadCapture(win: BrowserWindow): Promise<void> {
  return loadRendererPage(win, "capture.html");
}

function waitForReady(win: BrowserWindow): { promise: Promise<void>; cancel: () => void } {
  let cancel = (): void => {};
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new Error("采集没起来"))), 20_000);
    const ok = (event: Electron.IpcMainEvent): void => { if (event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame) finish(() => resolve()); };
    const fail = (event: Electron.IpcMainEvent, message: unknown): void => {
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return;
      finish(() => reject(new Error(typeof message === "string" && message ? message : "采集没起来")));
    };
    function cleanup(): void {
      clearTimeout(timer);
      ipcMain.removeListener("capture:ready", ok);
      ipcMain.removeListener("capture:failed", fail);
    }
    function finish(done: () => void): void {
      if (settled) return;
      settled = true;
      cleanup();
      done();
    }
    cancel = (): void => finish(() => reject(new Error("采集没起来")));
    ipcMain.on("capture:ready", ok);
    ipcMain.on("capture:failed", fail);
  });
  return { promise, cancel };
}

function asTrack(value: unknown): Track | null {
  return value === "you" || value === "other" ? value : null;
}

export async function startCapture(opts: {
  destDir: string;
  onPcm: (track: Track, pcm: Buffer) => void;
  onCrash: () => void;
}): Promise<{ stop: () => Promise<void> }> {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1, height: 1 },
  });
  const source = sources[0];
  if (!source) throw new Error("没有可录的屏幕");

  const writers = {
    you: createPcmWavWriter(join(opts.destDir, "mic.wav")),
    other: createPcmWavWriter(join(opts.destDir, "system.wav")),
  };
  const win = new BrowserWindow({
    show: false,
    width: 4,
    height: 4,
    skipTaskbar: true,
    webPreferences: {
      partition: "recording-capture",
      preload: capturePreloadPath(),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  configureCapturePermissions(win, "capture.html");
  let stopped = false;
  const onPcm = (event: Electron.IpcMainEvent, trackRaw: unknown, pcm: unknown): void => {
    if (stopped || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame
      || !(pcm instanceof Uint8Array) || pcm.byteLength > 16384 || pcm.byteLength % 2) return;
    const track = asTrack(trackRaw);
    if (!track) return;
    const buf = Buffer.from(pcm);
    writers[track].write(buf);
    opts.onPcm(track, buf);
  };
  ipcMain.on("capture:pcm", onPcm);
  ipcMain.removeHandler("capture:begin");
  ipcMain.handle("capture:begin", (event) => {
    if (stopped || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("无效的采集请求");
    return { sourceId: source.id };
  });

  const teardown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      ipcMain.removeListener("capture:pcm", onPcm);
      ipcMain.removeHandler("capture:begin");
      if (!win.isDestroyed()) win.close();
    } finally {
      writers.you.close();
      writers.other.close();
    }
  };

  const ready = waitForReady(win);
  try {
    await loadCapture(win);
    await ready.promise;
    // 两轨真的跑起来了，这才是屏幕录制权限的可信证据
    noteScreenGranted();
  } catch (err) {
    ready.cancel();
    await Promise.allSettled([ready.promise]);
    await teardown();
    throw err;
  }

  win.webContents.on("render-process-gone", () => {
    if (stopped) return;
    opts.onCrash();
  });

  return {
    stop: teardown,
  };
}
