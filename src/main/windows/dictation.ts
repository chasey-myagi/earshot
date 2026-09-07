import { BrowserWindow, screen } from 'electron';
import { loadRenderer, rendererPreloadPath } from './load';
import type { DictationState } from '../../shared/dictation';

export function createDictationWindow() {
  let win: BrowserWindow | null = null, loaded = false;
  let current: DictationState | null = null, previousHeight = 0;
  function paint() {
    if (!win || win.isDestroyed() || !loaded || !current) return;
    win.webContents.send('earshot:dictation', current);
    if (current.phase === 'idle') { win.hide(); return; }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const expanded = Boolean(current.text) || current.phase === 'error';
    const width = Math.min(380, area.width), height = expanded ? 220 : 94;
    if (!win.isVisible()) win.setBounds({ x: area.x + Math.round((area.width - width) / 2), y: area.y + 12, width, height });
    else if (previousHeight !== height) win.setSize(width, height);
    previousHeight = height;
    if (!win.isVisible()) win.showInactive();
  }
  return {
    show(state: DictationState) {
      current = state;
      if ((!win || win.isDestroyed()) && state.phase !== 'idle') {
        loaded = false;
        win = new BrowserWindow({ title: 'Earshot 语音输入', width: 380, height: 94, frame: false, transparent: true,
          hasShadow: false, show: false, focusable: false, skipTaskbar: true, resizable: false, movable: false,
          minimizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true,
          webPreferences: { preload: rendererPreloadPath(), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
        win.setAlwaysOnTop(true, 'floating');
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        win.webContents.once('did-finish-load', () => { loaded = true; paint(); });
        loadRenderer(win, 'dictation');
      }
      paint();
    },
    close: () => { if (win && !win.isDestroyed()) win.destroy(); win = null; },
  };
}
