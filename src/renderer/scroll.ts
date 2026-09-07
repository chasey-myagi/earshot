/** 距底部 threshold px 内视为「跟着最新行」 */
export function shouldStickToBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 48,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

export function scrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "auto" : "smooth";
}

export type ScrollRow = { id: string; timeMs: number; top: number; height: number };
export type ScrollAnchor = {
  id: string | null; timeMs: number; offset: number; top: number; following: boolean; confirmedCount: number;
};

export function captureScrollAnchor(
  rows: ScrollRow[], top: number, height: number, viewport: number, confirmedCount: number,
): ScrollAnchor {
  const row = rows.find(row => row.top + row.height > top) ?? rows.at(-1);
  return { id: row?.id ?? null, timeMs: row?.timeMs ?? 0, offset: row ? top - row.top : 0, top,
    following: shouldStickToBottom(top, height, viewport), confirmedCount };
}

export function restoreScrollTop(anchor: ScrollAnchor, rows: ScrollRow[], height: number, viewport: number): number {
  const max = Math.max(0, height - viewport);
  if (anchor.following) return max;
  const row = rows.find(row => row.id === anchor.id) ??
    [...rows].reverse().find(row => row.timeMs <= anchor.timeMs) ?? rows[0];
  return Math.max(0, Math.min(max, row ? row.top + Math.min(anchor.offset, row.height - 1) : anchor.top));
}
