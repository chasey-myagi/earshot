/** OS-only boundary; actual menu construction remains production code in tests. */
export function trayFixture() {
  const trays = [];
  return {
    trays,
    Tray: class {
      constructor(icon) { this.icon = icon; trays.push(this); }
      setToolTip(value) { this.tooltip = value; }
      setContextMenu(value) { this.menu = value; }
      destroy() { this.destroyed = true; }
    },
    Menu: { buildFromTemplate: entries => entries },
    nativeImage: { createFromBitmap: (buffer, options) => ({ buffer, options, setTemplateImage(value) { this.template = value; } }) },
  };
}
