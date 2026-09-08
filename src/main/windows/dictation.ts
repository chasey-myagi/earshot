import { BrowserWindow, screen } from 'electron';
import { loadRenderer, rendererPreloadPath } from './load';
import type { DictationState } from '../../shared/dictation';

export function createDictationWindow() {
  let win: BrowserWindow | null = null, loaded = false;
  let current: DictationState | null = null;
  let anchor: { x: number; y: number } | undefined;
  function paint() {
    if (!win || win.isDestroyed() || !loaded || !current) return;
    win.webContents.send('earshot:dictation', current);
    if (current.phase === 'idle') { win.hide(); return; }
    const area = screen.getDisplayNearestPoint(anchor!).workArea;
    const expanded = (current.phase === 'result' && Boolean(current.text)) || current.phase === 'error';
    const width = Math.min(380, area.width), height = expanded ? 220 : 94;
    const bounds = { x: area.x + Math.round((area.width - width) / 2), y: area.y + 12, width, height };
    const previous = win.getBounds();
    if (previous.x !== bounds.x || previous.y !== bounds.y || previous.width !== width || previous.height !== height) win.setBounds(bounds);
    if (!win.isVisible()) win.showInactive();
  }
  function prepare() {
    if (win && !win.isDestroyed()) return;
    loaded = false;
    win = new BrowserWindow({ title: 'Earshot 语音输入', type: 'panel', width: 380, height: 94, frame: false, transparent: true,
      hasShadow: false, show: false, focusable: false, skipTaskbar: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true,
      webPreferences: { preload: rendererPreloadPath(), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.webContents.once('did-finish-load', () => { loaded = true; paint(); });
    loadRenderer(win, 'dictation');
  }
  return {
    prepare,
    show(state: DictationState, screenPoint?: { x: number; y: number }) {
      // Pin both the input target and the pointer fallback until this dictation ends.
      if (state.phase === 'idle') anchor = undefined;
      else if (!anchor) anchor = { ...(screenPoint ?? screen.getCursorScreenPoint()) };
      current = state;
      if (state.phase !== 'idle') prepare();
      paint();
    },
    close: () => { if (win && !win.isDestroyed()) win.destroy(); win = null; },
  };
}
