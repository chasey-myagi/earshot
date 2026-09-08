import { Menu, Tray, nativeImage } from 'electron';
import type { CapturePhase } from '../shared/types';
import { shortcutLabel, type ShortcutStatus } from '../shared/dictation';

export function createMenubar(actions: {
  open: () => void; settings: () => void; start: () => void; stop: () => void; quit: () => void;
}) {
  // Monochrome template follows the system menu bar in both appearances.
  const pixels = Buffer.alloc(18 * 18 * 4);
  [5, 10, 15, 10, 5].forEach((height, index) => {
    const top = Math.floor((18 - height) / 2);
    for (let y = top; y < top + height; y++) for (let x = 2 + index * 3; x < 4 + index * 3; x++) pixels[(y * 18 + x) * 4 + 3] = 255;
  });
  const icon = nativeImage.createFromBitmap(pixels, { width: 18, height: 18, scaleFactor: 1 });
  icon.setTemplateImage(true);
  const tray = new Tray(icon);
  let previous = '';
  tray.setToolTip('Earshot');
  return {
    update(phase: CapturePhase, busy: boolean, shortcuts?: ShortcutStatus) {
      const fingerprint = JSON.stringify([phase, busy, shortcuts]);
      if (fingerprint === previous) return;
      previous = fingerprint;
      const active = phase === 'recording' || phase === 'finalize_failed';
      tray.setToolTip(active ? 'Earshot · 正在录制' : 'Earshot · 语音输入已就绪');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开 Earshot', click: actions.open },
        { type: 'separator' },
        { label: active ? phase === 'finalize_failed' ? '重试保存录音' : '停止录制并保存' : '开始录制',
          enabled: active || (phase === 'idle' && !busy), click: active ? actions.stop : actions.start },
        { label: shortcuts?.prefs.enabled ? `按住 ${shortcutLabel(shortcuts.prefs.dictation)} 语音输入` : '语音输入已关闭', enabled: false },
        ...(shortcuts?.error ? [{ label: '快捷键需要处理，请打开设置', click: actions.settings }] : []),
        { type: 'separator' },
        { label: '设置…', click: actions.settings },
        { label: '退出 Earshot', click: actions.quit },
      ]));
    },
    close() { tray.destroy(); },
  };
}
