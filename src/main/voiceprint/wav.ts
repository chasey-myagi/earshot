import { closeSync, openSync, readSync } from "node:fs";

export type WavInfo = {
  audioFormat: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
};

export function inspectWav(path: string): WavInfo {
  const fd = openSync(path, "r");
  try {
    return inspectWavFd(fd);
  } finally {
    closeSync(fd);
  }
}

export function wavDurationMs(path: string): number {
  const info = inspectWav(path);
  const bytesPerSec = info.sampleRate * info.channels * (info.bitsPerSample / 8);
  if (bytesPerSec <= 0) return 0;
  return (info.dataBytes / bytesPerSec) * 1000;
}

export function s16leToFloat32(pcm: Buffer): Float32Array {
  const count = pcm.length >> 1;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

export function readWavRange(path: string, startMs: number, endMs: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const info = inspectWavFd(fd);
    const bytesPerSample = (info.bitsPerSample / 8) * info.channels;
    if (bytesPerSample <= 0) return Buffer.alloc(0);
    const startSample = Math.max(0, Math.floor((startMs * info.sampleRate) / 1000));
    const endSample = Math.max(startSample, Math.ceil((endMs * info.sampleRate) / 1000));
    const startByte = startSample * bytesPerSample;
    const wanted = (endSample - startSample) * bytesPerSample;
    const length = Math.max(0, Math.min(wanted, info.dataBytes - startByte));
    const buf = Buffer.alloc(length);
    if (length > 0) readSync(fd, buf, 0, length, info.dataOffset + startByte);
    return buf;
  } finally {
    closeSync(fd);
  }
}

function inspectWavFd(fd: number): WavInfo {
  const ident = Buffer.alloc(12);
  readSync(fd, ident, 0, 12, 0);
  if (ident.toString("ascii", 0, 4) !== "RIFF" || ident.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAVE file");
  }
  let pos = 12;
  const hdr = Buffer.alloc(8);
  let sampleRate = 16000;
  let channels = 1;
  let bitsPerSample = 16;
  let audioFormat = 0;
  for (;;) {
    const n = readSync(fd, hdr, 0, 8, pos);
    if (n < 8) throw new Error("WAVE data chunk missing");
    const id = hdr.toString("ascii", 0, 4);
    const size = hdr.readUInt32LE(4);
    pos += 8;
    if (id === "fmt ") {
      if (size < 16) throw new Error("WAVE format chunk is incomplete");
      const fmt = Buffer.alloc(Math.min(size, 16));
      readSync(fd, fmt, 0, fmt.length, pos);
      audioFormat = fmt.readUInt16LE(0);
      channels = fmt.readUInt16LE(2);
      sampleRate = fmt.readUInt32LE(4);
      bitsPerSample = fmt.readUInt16LE(14);
    }
    if (id === "data") {
      return { audioFormat, sampleRate, channels, bitsPerSample, dataOffset: pos, dataBytes: size };
    }
    pos += size + (size % 2);
  }
}
