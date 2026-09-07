import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { inspectWav, type WavInfo } from "./voiceprint/wav.ts";

const RATE = 16000;
const HEADER_BYTES = 44;
export const AUDIO_CHUNK_BYTES = 64 * 1024;
type AudioTrack = WavInfo & { path: string };

function track(path: string): AudioTrack | null {
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) return null;
    const info = inspectWav(path);
    if (info.audioFormat !== 1 || info.sampleRate !== RATE || info.channels !== 1 || info.bitsPerSample !== 16 ||
      info.dataBytes < 2 || info.dataBytes % 2 || info.dataOffset + info.dataBytes > file.size) return null;
    return { ...info, path };
  } catch { return null; }
}

function header(dataBytes: number): Buffer {
  const out = Buffer.alloc(HEADER_BYTES);
  out.write("RIFF"); out.writeUInt32LE(dataBytes + 36, 4); out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(RATE, 24); out.writeUInt32LE(RATE * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(dataBytes, 40);
  return out;
}

/** A virtual mono WAV: random reads mix matching sample offsets, with bounded memory. */
export function openSessionAudio(dir: string) {
  const tracks = ["mic.wav", "system.wav"].map(name => track(join(dir, name)))
    .filter((value): value is AudioTrack => value !== null);
  if (!tracks.length) throw new Error("没有可播放的音轨，文件可能缺失或损坏");
  const dataBytes = Math.max(...tracks.map(t => t.dataBytes));
  if (dataBytes > 0xffffffff - 36) throw new Error("这场录音超出了 WAV 回听长度限制");
  const prefix = header(dataBytes);
  const byteLength = HEADER_BYTES + dataBytes;

  return {
    byteLength,
    durationSec: dataBytes / 2 / RATE,
    warning: tracks.length === 1 ? "当前只有一路可用音轨" : undefined,
    openReader() {
      const opened: { info: AudioTrack; fd: number }[] = [];
      let closed = false;
      function close(): void {
        if (closed) return;
        closed = true;
        for (const { fd } of opened) closeSync(fd);
      }
      try { for (const info of tracks) opened.push({ info, fd: openSync(info.path, "r") }); }
      catch (error) { close(); throw error; }
      return {
        close,
        read(offset: number, length: number): Buffer {
          if (closed) throw new Error("音频读取已结束");
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
            length > AUDIO_CHUNK_BYTES || offset + length > byteLength) throw new Error("无效的音频读取范围");
          const out = Buffer.alloc(length);
          if (offset < HEADER_BYTES) prefix.copy(out, 0, offset, Math.min(HEADER_BYTES, offset + length));
          const start = Math.max(offset, HEADER_BYTES);
          const end = offset + length;
          if (end <= start) return out;
          const firstSample = Math.floor((start - HEADER_BYTES) / 2);
          const sampleCount = Math.ceil((end - HEADER_BYTES) / 2) - firstSample;
          const mixed = Buffer.alloc(sampleCount * 2);
          const inputs = opened.map(({ info, fd }) => {
            const pcm = Buffer.alloc(sampleCount * 2);
            const available = Math.max(0, Math.min(pcm.length, info.dataBytes - firstSample * 2));
            if (available && readSync(fd, pcm, 0, available, info.dataOffset + firstSample * 2) !== available) {
              throw new Error("音轨在读取时发生变化");
            }
            return pcm;
          });
          for (let i = 0; i < sampleCount; i++) {
            const value = Math.round(inputs.reduce((sum, pcm) => sum + pcm.readInt16LE(i * 2), 0) / inputs.length);
            mixed.writeInt16LE(value, i * 2);
          }
          const skip = (start - HEADER_BYTES) % 2;
          mixed.copy(out, start - offset, skip, skip + end - start);
          return out;
        },
      };
    },
  };
}

export type SessionAudio = ReturnType<typeof openSessionAudio>;

function byteRange(value: string, size: number): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const a = Number(match[1]), b = Number(match[2]);
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
  if (!match[1]) return b > 0 ? [Math.max(0, size - b), size - 1] : null;
  const end = match[2] ? Math.min(b, size - 1) : size - 1;
  return a < size && end >= a ? [a, end] : null;
}

/** Chromium requests byte ranges when seeking; each pull reads at most 64 KiB per track. */
export function audioResponse(request: Request, audio: SessionAudio, authorized = () => true, revocation?: AbortSignal): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? byteRange(rangeHeader, audio.byteLength) : [0, audio.byteLength - 1];
  if (!range) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${audio.byteLength}` } });
  const [start, end] = range;
  const headers = new Headers({ "Content-Type": "audio/wav", "Accept-Ranges": "bytes",
    "Content-Length": String(end - start + 1), "Cache-Control": "no-store" });
  if (rangeHeader) headers.set("Content-Range", `bytes ${start}-${end}/${audio.byteLength}`);
  const status = rangeHeader ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const reader = audio.openReader();
  let cursor = start;
  let disposed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    request.signal.removeEventListener("abort", abort);
    revocation?.removeEventListener("abort", abort);
    reader.close();
  }
  function abort(): void { if (disposed) return; dispose(); controller.error(new Error("音频请求已结束")); }
  const body = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
      request.signal.addEventListener("abort", abort, { once: true });
      revocation?.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted || revocation?.aborted) abort();
    },
    pull(next) {
      try {
        if (!authorized()) throw new Error("回听已结束");
        const chunk = reader.read(cursor, Math.min(AUDIO_CHUNK_BYTES, end - cursor + 1));
        cursor += chunk.length;
        next.enqueue(chunk);
        if (cursor > end) { dispose(); next.close(); }
      } catch { dispose(); next.error(new Error("音频读取失败，请重新打开回听")); }
    },
    cancel() { dispose(); },
  });
  return new Response(body, { status, headers });
}
