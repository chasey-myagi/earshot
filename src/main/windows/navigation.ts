type WindowPort = { show: () => void; showInactive: () => void; hide: () => void; focus: () => void };

/** Window navigation never owns capture: closing a surface only changes visibility. */
export function createWindowNavigation(opts: {
  library: () => WindowPort;
  glance: (create?: boolean) => WindowPort | null;
  recordingId: () => string | null;
  select: (id: string) => void;
  opened?: () => void;
}) {
  return {
    openLibrary(): void {
      const id = opts.recordingId();
      if (id) opts.select(id);
      opts.opened?.();
      opts.glance()?.hide();
      const win = opts.library();
      win.show();
      win.focus();
    },
    showGlance(): void {
      if (!opts.recordingId()) return;
      opts.library().hide();
      opts.glance(true)?.showInactive();
    },
    hideGlance(): void {
      opts.glance()?.hide();
    },
    closeLibrary(quitting: boolean): boolean {
      if (quitting) return true;
      opts.library().hide();
      if (opts.recordingId()) opts.glance(true)?.showInactive();
      return false;
    },
  };
}
