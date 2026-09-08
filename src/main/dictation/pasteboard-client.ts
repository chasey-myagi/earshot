import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PasteClipboard } from './clipboard';

const incomplete = (message: string) => Object.assign(new Error(message), { warning: '剪贴板收尾尚未确认，原内容可能未恢复，请检查剪贴板' });

type Request = { action: string; text?: string; leaseId?: string };
export function createPasteboardClient(): PasteClipboard {
  let worker: Worker | undefined, next = 0, stalled: number | undefined, failed = false, closing = false, stopped = false;
  let tail: Promise<unknown> = Promise.resolve(), closePromise: Promise<void> | undefined;
  const pending = new Map<number, { action: string; finish: (error?: Error, value?: unknown) => void; canceled: Int32Array }>();
  function start() {
    if (worker) return worker;
    const here = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
    worker = new Worker(join(here, 'dictation-pasteboard-worker.js'));
    worker.on('message', (reply: { id: number; ok: boolean; error?: string; warning?: string; value?: unknown }) => {
      const request = pending.get(reply.id);
      if (!request) return;
      // Keep timed-out requests until their native operation actually returns.
      // The same thread settles its lease before a later explicit copy can run.
      pending.delete(reply.id);
      if (stalled === reply.id) stalled = undefined;
      if (request.action === 'close' && reply.ok) stopped = true;
      request.finish(reply.ok ? undefined : Object.assign(new Error(reply.error ?? '剪贴板暂不可用'), { warning: reply.warning }), reply.value);
    });
    const failure = () => {
      if (stopped) return;
      failed = true;
      for (const request of pending.values()) request.finish(incomplete('剪贴板服务已停止，请重新打开 Earshot'));
      pending.clear();
    };
    worker.on('error', failure); worker.on('exit', failure); worker.unref();
    return worker;
  }
  function request(input: Request, signal?: AbortSignal): Promise<unknown> {
    const work = tail.then(() => {
      // A dead thread has already lost its memory; there is no cleanup to await.
      // Keep a normal quit/restart path, unlike a live thread that is still restoring.
      if (input.action === 'close' && (stopped || failed)) return;
      if (failed) throw incomplete('剪贴板服务已停止，请重新打开 Earshot');
      if (input.action !== 'close' && (stalled !== undefined || closing)) throw incomplete('剪贴板仍在收尾，请稍后再复制');
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const id = ++next, flag = new Int32Array(new SharedArrayBuffer(4));
        let settled = false;
        const cancel = () => { Atomics.store(flag, 0, 1); };
        const timer = setTimeout(() => {
          stalled = id; cancel();
          // Never start a second thread around an uninterruptible data provider.
          finish(incomplete('剪贴板操作超时，正在收尾；请稍后再复制'));
        }, 2000);
        const finish = (error?: Error, value?: unknown) => {
          if (settled) return; settled = true;
          clearTimeout(timer); signal?.removeEventListener('abort', cancel);
          if (error) reject(error); else resolve(value);
        };
        pending.set(id, { action: input.action, finish, canceled: flag });
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        try { start().postMessage({ ...input, id, canceled: flag.buffer }); }
        catch { pending.delete(id); finish(incomplete('剪贴板暂不可用，请稍后再复制')); }
      });
    });
    tail = work.catch(() => undefined);
    return work;
  }
  return {
    claim: (text, signal) => request({ action: 'claim', text }, signal) as Promise<string>,
    owned: id => request({ action: 'owned', leaseId: id }) as Promise<boolean>,
    finish: id => request({ action: 'finish', leaseId: id }),
    copy: async text => { await request({ action: 'copy', text }); },
    close() {
      closing = true;
      if (!worker || stopped || failed) return Promise.resolve();
      if (closePromise) return closePromise;
      for (const request of pending.values()) Atomics.store(request.canceled, 0, 1);
      // Queue behind the existing operation and await its cleanup acknowledgment.
      // A timeout rejects: the app must remain open with the original bytes in RAM.
      closePromise = request({ action: 'close' }).then(() => undefined).finally(() => { closePromise = undefined; });
      return closePromise;
    },
  };
}
