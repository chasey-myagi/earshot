import { BrowserWindow, nativeTheme } from "electron";
import { rendererPreloadPath } from "./load";

function canvasBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#161826" : "#f1f1f6";
}

export function createLibraryWindow(): BrowserWindow {
  const preload = rendererPreloadPath();
  console.log("[earshot] preload", preload);
  return new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 800,
    minHeight: 560,
    title: "Earshot",
    titleBarStyle: "hiddenInset",
    show: false,
    backgroundColor: canvasBackground(),
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
    },
  });
}
