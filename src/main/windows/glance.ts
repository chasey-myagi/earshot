import { BrowserWindow, nativeTheme } from "electron";
import { rendererPreloadPath } from "./load";

function canvasBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#161826" : "#f1f1f6";
}

export function createGlanceWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 380,
    height: 300,
    minWidth: 320,
    minHeight: 220,
    title: "Earshot",
    alwaysOnTop: true,
    show: false,
    frame: false,
    transparent: false,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: canvasBackground(),
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: rendererPreloadPath(),
      contextIsolation: true,
      sandbox: true,
    },
  });
}
