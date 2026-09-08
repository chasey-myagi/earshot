import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createPcmWavWriter } from './store/wav.ts';

// Chromium's decoder materializes the encoded file and decoded channels. Bound both.
export const AUDIO_IMPORT_LIMITS = { bytes: 64 * 1024 * 1024, durationSec: 30 * 60, sampleRate: 16000, chunkBytes: 256 * 1024 } as const;
export const AUDIO_IMPORT_EXTENSIONS = ['wav', 'mp3', 'm4a'] as const;
export type ImportProgress = { phase: 'copying' | 'decoding' | 'saving'; percent: number };
export type ImportResult = { id: string; title: string; durationSec: number; originalFilename: string };
export type AudioDecoder = (path: string, options: {
  signal: AbortSignal;
  onPCM: (bytes: Uint8Array) => void;
  onProgress?: (progress: number) => void;
}) => Promise<{ durationSec: number }>;

/** The path is supplied only by the main-process file picker, never renderer IPC. */
export async function importAudio(options: {
  sourcePath: string;
  sessionsRoot: string;
  decode: AudioDecoder;
  commit: (result: ImportResult) => void;
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
}): Promise<ImportResult> {
  const signal = options.signal ?? new AbortController().signal;
  const check = () => { if (signal.aborted) throw new Error('已取消导入'); };
  check();
  const extension = extname(options.sourcePath).toLowerCase();
  if (!AUDIO_IMPORT_EXTENSIONS.some(value => extension === `.${value}`)) throw new Error('请选择 WAV、MP3 或 M4A 音频');
  const id = randomUUID();
  const staging = join(options.sessionsRoot, `.import-${id}`);
  const destination = join(options.sessionsRoot, id);
  let ownsStaging = false, ownsDestination = false;
  let writer: ReturnType<typeof createPcmWavWriter> | null = null;
  const progress = (phase: ImportProgress['phase'], percent: number) => {
    // UI notifications are observational; a closing window cannot roll back a committed session.
    try { options.onProgress?.({ phase, percent }); } catch {}
  };
  try {
    // Read-only descriptor prevents importing devices/directories; a changing source is rejected.
    const source = await open(options.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await source.stat();
      if (!before.isFile() || before.size <= 0) throw new Error('请选择非空的音频文件');
      if (before.size > AUDIO_IMPORT_LIMITS.bytes) throw new Error('单个音频最多 64 MB；请先分段再导入');
      await mkdir(options.sessionsRoot, { recursive: true });
      await mkdir(staging, { mode: 0o700 }); ownsStaging = true;
      const original = await open(join(staging, `original${extension}`), 'wx', 0o600);
      try {
        let copied = 0;
        const buffer = Buffer.alloc(AUDIO_IMPORT_LIMITS.chunkBytes);
        progress('copying', 0);
        for (;;) {
          check();
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          copied += bytesRead;
          if (copied > before.size || copied > AUDIO_IMPORT_LIMITS.bytes) throw new Error('音频文件在导入时发生变化，请重试');
          let written = 0;
          while (written < bytesRead) written += (await original.write(buffer, written, bytesRead - written)).bytesWritten;
          progress('copying', Math.round(copied / before.size * 100));
        }
        const after = await source.stat();
        if (copied !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('音频文件在导入时发生变化，请重试');
        await original.sync();
      } finally { await original.close(); }
    } finally { await source.close(); }
    check();
    const wavPath = join(staging, 'system.wav');
    writer = createPcmWavWriter(wavPath); await chmod(wavPath, 0o600);
    let pcmBytes = 0;
    progress('decoding', 0);
    const decoded = await options.decode(join(staging, `original${extension}`), {
      signal,
      onProgress: value => progress('decoding', Math.max(0, Math.min(100, Math.round(value)))),
      onPCM: chunk => {
        check();
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength % 2 || chunk.byteLength > AUDIO_IMPORT_LIMITS.chunkBytes) {
          throw new Error('音频解码返回了无效的数据');
        }
        pcmBytes += chunk.byteLength;
        if (pcmBytes > AUDIO_IMPORT_LIMITS.durationSec * AUDIO_IMPORT_LIMITS.sampleRate * 2) throw new Error('音频最长 30 分钟；请先分段再导入');
        writer!.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      },
    });
    check();
    const durationSec = pcmBytes / (AUDIO_IMPORT_LIMITS.sampleRate * 2);
    if (!Number.isFinite(decoded.durationSec) || durationSec <= 0 || decoded.durationSec <= 0 ||
      decoded.durationSec > AUDIO_IMPORT_LIMITS.durationSec || Math.abs(durationSec - decoded.durationSec) > 1 / AUDIO_IMPORT_LIMITS.sampleRate) {
      throw new Error('音频解码未完整完成，请检查文件后重试');
    }
    writer.close(); writer = null;
    progress('saving', 0);
    const originalFilename = basename(options.sourcePath).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
    const result = { id, originalFilename, durationSec,
      title: Array.from(basename(originalFilename, extname(originalFilename)).trim()).slice(0, 80).join('') || '导入的录音' };
    // No session.json is visible until audio is complete. Parent commits metadata, then enqueues jobs.
    await rename(staging, destination); ownsStaging = false; ownsDestination = true;
    check();
    options.commit(result);
    ownsDestination = false;
    progress('saving', 100);
    return result;
  } catch (error) {
    if (signal.aborted) throw new Error('已取消导入');
    throw error;
  } finally {
    if (writer) { try { writer.close(); } catch {} }
    if (ownsStaging) await rm(staging, { recursive: true, force: true });
    if (ownsDestination) await rm(destination, { recursive: true, force: true });
  }
}
