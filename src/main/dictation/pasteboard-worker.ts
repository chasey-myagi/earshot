import { parentPort } from 'node:worker_threads';
import { createMacPasteboard } from './macos-pasteboard';
import { ClipboardRestoreError, createClipboardLease } from './clipboard';

// One thread inside the Electron main process, not a helper executable or daemon.
// A delayed NSPasteboard provider must not block the app's global shortcut/HUD.
const port = parentPort!;
let board: ReturnType<typeof createMacPasteboard> | undefined;
let lease: ReturnType<typeof createClipboardLease> | undefined;
let cleanup: ReturnType<typeof setTimeout> | undefined;
port.on('message', (request: { id: number; action: string; text?: string; leaseId?: string; canceled: SharedArrayBuffer }) => {
  const flag = new Int32Array(request.canceled), cancelled = () => Atomics.load(flag, 0) !== 0;
  try {
    board ??= createMacPasteboard(); lease ??= createClipboardLease(board);
    let value: unknown;
    if (request.action === 'claim') {
      value = lease.claim(request.text ?? '', cancelled);
      clearTimeout(cleanup);
      // Bound orphaned snapshots if the client disappears after acquiring a lease.
      cleanup = setTimeout(() => { try { lease?.finish(); } catch { /* retain for normal close */ } }, 10_000);
    } else if (request.action === 'owned') value = !cancelled() && lease.owned(request.leaseId ?? '');
    else if (request.action === 'finish') { value = lease.finish(request.leaseId); clearTimeout(cleanup); }
    else if (request.action === 'copy') value = lease.copy(request.text ?? '', cancelled);
    else if (request.action === 'close') {
      clearTimeout(cleanup); lease.finish(); lease.discard(); board.close();
    } else throw new Error('无效的剪贴板操作');
    // A timeout/cancel during a slow claim must not leave a late temporary write.
    if (request.action === 'claim' && cancelled()) { lease.finish(value as string); throw new Error('已取消输入'); }
    port.postMessage({ id: request.id, ok: true, value });
    if (request.action === 'close') port.close();
  } catch (error) {
    // Also clean up failed claims/restores that retained their owned snapshot.
    clearTimeout(cleanup);
    cleanup = setTimeout(() => { try { lease?.finish(); } catch { /* preserve originals until a later explicit cleanup */ } }, 1000);
    port.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : '剪贴板暂不可用',
      warning: error instanceof ClipboardRestoreError ? error.warning : undefined });
  }
});
