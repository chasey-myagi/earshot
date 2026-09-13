export type SessionSelection = { ids: string[]; anchor: string | null };

/** Range selection follows the visible, grouped list, including both session kinds. */
export function selectSessionRows(current: SessionSelection, visible: string[], id: string, modifiers: { metaKey?: boolean; shiftKey?: boolean } = {}): SessionSelection {
  if (!visible.includes(id)) return current;
  const kept = current.ids.filter(value => visible.includes(value));
  if (modifiers.shiftKey) {
    const anchor = current.anchor && visible.includes(current.anchor) ? current.anchor : id;
    const from = visible.indexOf(anchor), to = visible.indexOf(id);
    const range = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
    return { ids: modifiers.metaKey ? visible.filter(value => kept.includes(value) || range.includes(value)) : range, anchor };
  }
  if (modifiers.metaKey) {
    const ids = kept.includes(id) ? kept.filter(value => value !== id) : visible.filter(value => kept.includes(value) || value === id);
    return { ids, anchor: id };
  }
  return { ids: [id], anchor: id };
}
