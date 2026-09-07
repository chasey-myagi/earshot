// Canonical Electron accelerator; only modifier + physical key or a function key.
export function normalizeShortcut(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 100) return null;
  const parts = raw.split('+'), key = parts.pop() ?? '';
  const modifiers = ['Command', 'Control', 'Alt', 'Shift'];
  if (new Set(parts).size !== parts.length || parts.some(part => !modifiers.includes(part))) return null;
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|20)|Space|Tab|Enter|Backspace|Delete|Up|Down|Left|Right|Home|End|PageUp|PageDown|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/.test(key)) return null;
  if (!/^F\d+$/.test(key) && !parts.some(part => part !== 'Shift')) return null;
  return [...modifiers.filter(modifier => parts.includes(modifier)), key].join('+');
}
export function shortcutFromEvent(event: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  const key = event.code.replace(/^Key|^Digit/, '').replace(/^Arrow/, '');
  return normalizeShortcut([event.metaKey ? 'Command' : '', event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key].filter(Boolean).join('+'));
}
export function electronAccelerator(value: string): string {
  const keys: Record<string, string> = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`' };
  const parts = value.split('+');
  parts[parts.length - 1] = keys[parts.at(-1)!] ?? parts.at(-1)!;
  return parts.join('+');
}
