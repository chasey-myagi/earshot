import type { BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function resolvePreloadPath(dir: string): string {
  const cjs = join(dir, "index.js");
  const mjs = join(dir, "index.mjs");
  if (existsSync(cjs)) return cjs;
  if (existsSync(mjs)) return mjs;
  return cjs;
}

export function rendererPreloadPath(): string {
  return resolvePreloadPath(join(__dirname, "../preload"));
}

/** The build replaces this mode with a literal; a production app cannot enable it through its launch environment. */
export function developmentRendererUrl(): string | null {
  if (process.env.NODE_ENV_ELECTRON_VITE !== "development") return null;
  try {
    const url = new URL(process.env.ELECTRON_RENDERER_URL ?? "");
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function rendererPageUrl(page: string, hash?: string): string {
  const dev = developmentRendererUrl();
  const url = dev ? new URL(page, dev.endsWith("/") ? dev : `${dev}/`) : pathToFileURL(join(__dirname, "../renderer", page));
  if (hash) url.hash = hash;
  return url.href;
}

export function sameRendererDocument(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual), b = new URL(expected);
    return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
      && !a.username && !a.password && (a.protocol !== "file:" || a.hostname === "")
      && a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

export function loadRendererPage(win: BrowserWindow, page: string, hash?: string): Promise<void> {
  const expected = rendererPageUrl(page, hash);
  const preventNavigation = (event: Electron.Event, url: string): void => {
    if (!sameRendererDocument(url, expected)) event.preventDefault();
  };
  win.webContents.on("will-navigate", preventNavigation);
  win.webContents.on("will-redirect", preventNavigation);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return developmentRendererUrl() ? win.loadURL(expected)
    : win.loadFile(join(__dirname, "../renderer", page), hash ? { hash } : {});
}

/** Each capture surface has its own in-memory session; unrelated windows never receive media permission. */
export function configureCapturePermissions(win: BrowserWindow, page: string): void {
  const expected = rendererPageUrl(page);
  win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(!win.isDestroyed() && contents === win.webContents && details.isMainFrame !== false
      && sameRendererDocument(contents.getURL(), expected)
      && (!details.requestingUrl || sameRendererDocument(details.requestingUrl, expected))
      && (permission === "media" || (page === "capture.html" && permission === "display-capture")));
  });
  win.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    !win.isDestroyed() && contents === win.webContents && details.isMainFrame !== false
      && sameRendererDocument(contents.getURL(), expected)
      && permission === "media");
}

export function loadRenderer(win: BrowserWindow, hash?: string): void {
  void loadRendererPage(win, "index.html", hash);
}
