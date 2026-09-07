import type { InputTarget } from './controller';

export type Selection = { location: number; length: number };
export type EditableSnapshot = { value: string; range: Selection };
export type EditableTarget = {
  read: () => EditableSnapshot | null;
  focused: () => boolean;
  replace: (before: EditableSnapshot, text: string) => boolean;
  release: () => void;
};

export function validSelection(value: string, range: Selection): boolean {
  return Number.isSafeInteger(range.location) && Number.isSafeInteger(range.length)
    && range.location >= 0 && range.length >= 0 && range.location + range.length <= value.length;
}

// A result may arrive after the user has edited, selected another range, or switched apps.
export function protectInputTarget(target: EditableTarget): InputTarget | null {
  const before = target.read();
  if (!before || !validSelection(before.value, before.range)) { target.release(); return null; }
  let released = false, inserted = false;
  return {
    insert(text) {
      if (released || inserted || !text || !target.focused()) return false;
      const now = target.read();
      if (!now || now.value !== before.value || now.range.location !== before.range.location
        || now.range.length !== before.range.length) return false;
      // AX reads cross process boundaries; the user can switch focus while they complete.
      if (!target.focused()) return false;
      inserted = target.replace(before, text);
      return inserted;
    },
    release() { if (!released) { released = true; target.release(); } },
  };
}
