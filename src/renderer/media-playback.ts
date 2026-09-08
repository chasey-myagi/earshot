import type { PlaybackCommand, PlaybackReport, PlaybackStatus } from '../shared/types';

type Media = Pick<HTMLAudioElement, 'src' | 'preload' | 'paused' | 'ended' | 'readyState' | 'duration' |
  'currentTime' | 'playbackRate' | 'preservesPitch' | 'seeking' | 'play' | 'pause' | 'load' | 'removeAttribute' | 'addEventListener' | 'removeEventListener'>;
type Source = { media: Media; token: string; id: number; detach: () => void };

/** Survives Library/settings changes; only a new source or host disposal removes audio. */
export function createMediaPlayback(options: {
  createAudio: () => Media;
  report: (report: PlaybackReport) => void;
  timeoutMs?: number;
}) {
  let source: Source | null = null;
  let operation: AbortController | null = null;
  function disposeSource() {
    const old = source; source = null;
    if (!old) return;
    old.detach(); old.media.pause(); old.media.removeAttribute('src'); old.media.load();
  }
  function position(media: Media) { return Number.isFinite(media.currentTime) ? Math.max(0, media.currentTime) : 0; }
  function status(media: Media): PlaybackStatus { return media.ended ? 'ended' : media.paused ? 'paused' : 'playing'; }
  function publish(current: Source, ack = false, explicit?: PlaybackStatus) {
    if (source !== current) return;
    options.report({ token: current.token, commandId: current.id,
      positionSec: position(current.media), status: explicit ?? status(current.media), rate: current.media.playbackRate, ack });
  }
  function wait(media: Media, event: string, done: () => boolean, signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(new Error('Playback command replaced'));
    if (done()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer); media.removeEventListener(event, completed);
        media.removeEventListener('error', failed); signal.removeEventListener('abort', failed);
      };
      const completed = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Audio could not load')); };
      const timer = setTimeout(failed, options.timeoutMs ?? 10000);
      media.addEventListener(event, completed, { once: true });
      media.addEventListener('error', failed, { once: true });
      signal.addEventListener('abort', failed, { once: true });
    });
  }
  return {
    async command(command: PlaybackCommand) {
      operation?.abort();
      const op = new AbortController(); operation = op;
      const valid = () => operation === op && !op.signal.aborted;
      if (command.action === 'stop') {
        disposeSource();
        options.report({ token: command.token, commandId: command.id, status: 'idle', positionSec: 0, ack: true });
        return;
      }
      let current = source;
      try {
        if (command.action === 'load') {
          disposeSource();
          const media = options.createAudio();
          current = { media, token: command.token, id: command.id, detach() {} };
          source = current;
          const attached = current;
          const update = () => publish(attached);
          const failed = () => {
            if (source !== attached) return;
            const at = position(media);
            disposeSource();
            options.report({ token: attached.token, commandId: attached.id, status: 'error', positionSec: at, ack: true });
          };
          for (const event of ['timeupdate', 'play', 'pause', 'ended', 'seeked']) media.addEventListener(event, update);
          media.addEventListener('error', failed);
          current.detach = () => {
            for (const event of ['timeupdate', 'play', 'pause', 'ended', 'seeked']) media.removeEventListener(event, update);
            media.removeEventListener('error', failed);
          };
          media.preload = 'auto'; media.src = command.url!;
          const loaded = wait(media, 'loadedmetadata', () => media.readyState >= 1, op.signal);
          media.load(); await loaded;
        }
        if (!current || source !== current || current.token !== command.token || !valid()) return;
        current.id = command.id;
        const media = current.media;
        if (command.action === 'load' || command.action === 'rate') {
          const rate = command.rate ?? 1;
          if (![0.75, 1, 1.25, 1.5, 2].includes(rate)) throw new Error('Invalid playback rate');
          media.preservesPitch = true;
          media.playbackRate = rate;
          if (media.playbackRate !== rate) throw new Error('Playback rate was not applied');
        }
        if (command.action === 'pause') media.pause();
        if (command.action === 'load' || command.action === 'seek') {
          media.currentTime = Math.max(0, Math.min(command.positionSec ?? 0, media.duration));
          await wait(media, 'seeked', () => !media.seeking, op.signal);
        }
        if (!valid() || source !== current) return;
        if (command.action === 'load' || command.action === 'resume' || command.resume) {
          await media.play();
          if (!valid() || source !== current) { media.pause(); return; }
        }
        publish(current, true);
      } catch {
        if (!valid() || !current || source !== current) return;
        const at = position(current.media);
        disposeSource();
        options.report({ token: command.token, commandId: command.id, status: 'error', positionSec: at, ack: true });
      }
    },
    dispose() { operation?.abort(); operation = null; disposeSource(); },
  };
}
