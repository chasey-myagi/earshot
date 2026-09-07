import { randomUUID } from 'node:crypto';
import type { ActionResult, PlaybackCommand, PlaybackReport, PlaybackState } from '../shared/types';
import { audioResponse, openSessionAudio, type SessionAudio } from './playback-audio.ts';

type Pending = { id: number; action: PlaybackCommand['action']; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Main owns authorization; one Chromium media element owns the playback clock. */
export function createPlaybackController(options: {
  send: (command: PlaybackCommand) => void;
  onChange?: () => void;
  timeoutMs?: number;
}) {
  let state: PlaybackState | null = null;
  let audio: SessionAudio | null = null;
  let token: string | null = null;
  let authorized = false;
  let revocation = new AbortController();
  let ready = false;
  let commandId = 0;
  let pending: Pending | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const changed = () => options.onChange?.();
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action, action);
    queue = result.catch(() => {});
    return result;
  }
  function rejectPending(error: Error) {
    if (!pending) return;
    const current = pending; pending = null;
    clearTimeout(current.timer); current.reject(error);
  }
  function fail(error: unknown): ActionResult {
    const message = error instanceof Error ? error.message : '回听失败，请重试';
    if (state) state = { ...state, status: 'error', error: message };
    changed();
    return { ok: false, error: message };
  }
  function send(action: PlaybackCommand['action'], extra: Partial<PlaybackCommand> = {}): Promise<void> {
    if (!ready || !token) return Promise.reject(new Error('回听界面尚未就绪，请重新打开会库'));
    const id = ++commandId;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        rejectPending(new Error(action === 'stop' ? '回听尚未停止，请关闭回听后重试录音' : '回听没有响应，请重试'));
      }, options.timeoutMs ?? (action === 'load' ? 10000 : 2000));
      pending = { id, action, resolve, reject, timer };
      try { options.send({ ...extra, action, id, token: token! }); }
      catch (error) { rejectPending(error instanceof Error ? error : new Error('回听界面不可用')); }
    }).catch(error => { fail(error); throw error; });
  }
  function action(run: () => Promise<void>): Promise<ActionResult> {
    return serial(async () => {
      try { await run(); return { ok: true }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : '回听失败，请重试' }; }
    });
  }
  function hasPosition(value: number, length: number) {
    return Number.isFinite(value) && value >= 0 && value <= length;
  }
  function revoke() { authorized = false; revocation.abort(); }
  function clear() {
    revoke(); audio = null; token = null; state = null; changed();
  }
  async function load(dir: string, sessionId: string, title: string, positionSec: number) {
    if (!ready) throw new Error('回听界面尚未就绪，请重新打开会库');
    const next = openSessionAudio(dir);
    if (!hasPosition(positionSec, next.durationSec)) throw new Error('无效的回听位置');
    revoke(); revocation = new AbortController();
    audio = next; token = randomUUID(); authorized = true;
    state = { sessionId, title, status: 'loading', positionSec, durationSec: next.durationSec, warning: next.warning };
    changed();
    await send('load', { url: `earshot-audio://session/${token}`, positionSec });
  }
  return {
    snapshot: (): PlaybackState | null => state ? { ...state } : null,
    hostReady() { ready = true; },
    hostClosed() {
      ready = false;
      rejectPending(new Error('回听界面已关闭'));
      clear();
    },
    play(dir: string, sessionId: string, title: string, positionSec?: number): Promise<ActionResult> {
      return action(async () => {
        if (positionSec === undefined && authorized && state?.sessionId === sessionId) {
          if (state.status === 'playing') return;
          if (state.status === 'paused') { await send('resume'); return; }
        }
        await load(dir, sessionId, title, positionSec ?? 0);
      });
    },
    seekSession(dir: string, sessionId: string, title: string, positionSec: number, resume = false): Promise<ActionResult> {
      return action(async () => {
        // Resolve the target after earlier queued commands finish: they may change the source.
        if (state?.sessionId !== sessionId || state.status === 'error' || !authorized) return load(dir, sessionId, title, positionSec);
        if (!hasPosition(positionSec, state.durationSec)) throw new Error('无效的回听位置');
        await send('seek', { positionSec, resume });
      });
    },
    pause(sessionId = state?.sessionId): Promise<ActionResult> { return action(async () => {
      if (!state || state.sessionId !== sessionId) throw new Error('回听会话已改变，请重新操作');
      await send('pause');
    }); },
    resume(): Promise<ActionResult> { return action(async () => {
      if (!state) throw new Error('没有正在回听的录音');
      await send(state.status === 'ended' ? 'seek' : 'resume', state.status === 'ended' ? { positionSec: 0, resume: true } : {});
    }); },
    stopAndWait(): Promise<void> {
      return serial(async () => {
        if (!state || !token) return;
        revoke();
        try { await send('stop'); clear(); }
        catch (error) { fail(error); throw error; }
      });
    },
    report(raw: unknown) {
      if (!raw || typeof raw !== 'object' || !state || !token) return;
      const report = raw as Partial<PlaybackReport>;
      if (report.token !== token || report.commandId !== commandId || typeof report.positionSec !== 'number' ||
          !hasPosition(report.positionSec, state.durationSec + 0.05) ||
          !['loading', 'playing', 'paused', 'ended', 'error', 'idle'].includes(report.status ?? '')) return;
      if (report.status !== 'idle') {
        state = { ...state, status: report.status!, positionSec: Math.min(report.positionSec, state.durationSec),
          error: report.status === 'error' ? '音频无法播放，请重新打开回听' : undefined };
        changed();
      }
      const expectedAck = report.status === 'error' || (pending?.action === 'stop' ? report.status === 'idle'
        : pending?.action === 'pause' ? report.status === 'paused' || report.status === 'ended'
          : pending?.action === 'seek' ? ['paused','playing','ended'].includes(report.status!)
            : ['playing','ended'].includes(report.status!));
      if (report.ack === true && pending?.id === report.commandId && expectedAck) {
        const current = pending; pending = null; clearTimeout(current.timer);
        if (report.status === 'error') current.reject(new Error('音频无法播放，请重新打开回听'));
        else current.resolve();
      }
    },
    respond(request: Request): Response {
      const url = new URL(request.url);
      const expected = token;
      if (!authorized || !audio || !expected || url.protocol !== 'earshot-audio:' || url.hostname !== 'session' ||
          url.pathname !== `/${expected}` || url.search || url.hash || url.username || url.password) {
        return new Response(null, { status: 404 });
      }
      try { return audioResponse(request, audio, () => authorized && token === expected, revocation.signal); }
      catch { return new Response(null, { status: 500 }); }
    },
  };
}
