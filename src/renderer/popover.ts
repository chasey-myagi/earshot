export type PopoverPoint = { left: number; top: number };

/** 锚定触发元素，优先下方展开，必要时翻转并 clamp 到视口 */
export function anchorPopover(
  anchor: { left: number; top: number; right: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
  pad = 8,
): PopoverPoint {
  let left = anchor.left;
  let top = anchor.bottom + gap;

  if (left + size.width > viewport.width - pad) {
    left = Math.max(pad, viewport.width - size.width - pad);
  }
  if (left < pad) left = pad;

  if (top + size.height > viewport.height - pad) {
    top = anchor.top - size.height - gap;
  }
  if (top < pad) top = pad;

  return { left, top };
}
