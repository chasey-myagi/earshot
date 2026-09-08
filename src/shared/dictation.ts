export type DictationPhase = 'idle' | 'preparing' | 'listening' | 'transcribing' | 'result' | 'error' | 'success';
export type DictationState = { phase: DictationPhase; text: string; message: string; startedAt: number | null; level: number; retryable: boolean; resultKind?: 'preview' | 'delivery-failed' | 'delivery-unconfirmed' | 'delivery-canceled' | 'save-failed' | 'clipboard-warning' };
// wechatCompatibility is read for old settings compatibility only; all apps now use the same paste path.
export type ShortcutPrefs = { enabled: boolean; meeting: string; dictation: string; delivery: 'direct' | 'preview'; wechatCompatibility?: boolean; models?: import('./model-settings').ModelPrefs };
export type ShortcutStatus = { prefs: ShortcutPrefs; error?: string; accessibility: boolean; holdAvailable: boolean };
export const DEFAULT_SHORTCUTS: ShortcutPrefs = { enabled: true, meeting: 'Control+Alt+R', dictation: 'Alt+Space', delivery: 'direct', wechatCompatibility: false };

export function shortcutLabel(value: string): string {
  return value.replaceAll('Control+', '⌃').replaceAll('Command+', '⌘').replaceAll('Alt+', '⌥').replaceAll('Shift+', '⇧').replace('Space', ' 空格');
}
