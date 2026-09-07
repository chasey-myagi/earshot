import { closeSync, existsSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

const WAV_HEADER = 44;
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;

export function hasWavBody(filePath: string): boolean {
  try {
    return statSync(filePath).size > WAV_HEADER;
  } catch {
    return false;
  }
}

export function wavDurationSec(filePath: string): number | null {
  try {
    const size = statSync(filePath).size;
    if (size <= WAV_HEADER) return null;
    return Math.floor((size - WAV_HEADER) / BYTES_PER_SAMPLE / SAMPLE_RATE);
  } catch {
    return null;
  }
}

export function sessionDurationSec(sessionDir: string, fallbackSec: number): number {
  const mic = wavDurationSec(join(sessionDir, "mic.wav"));
  const system = wavDurationSec(join(sessionDir, "system.wav"));
  return Math.max(fallbackSec, mic ?? 0, system ?? 0);
}

export function sessionHasWavBody(sessionDir: string): boolean {
  return hasWavBody(join(sessionDir, "mic.wav")) || hasWavBody(join(sessionDir, "system.wav"));
}

export function repairWavHeader(filePath: string): void {
  if (!existsSync(filePath)) return;
  const size = statSync(filePath).size;
  if (size < WAV_HEADER) return;
  const fd = openSync(filePath, "r+");
  try {
    const ident = Buffer.alloc(4);
    readSync(fd, ident, 0, 4, 0);
    if (ident.toString("ascii") !== "RIFF") return;
    const riffSize = Buffer.alloc(4);
    riffSize.writeUInt32LE(size - 8);
    writeSync(fd, riffSize, 0, 4, 4);
    const dataSize = Buffer.alloc(4);
    dataSize.writeUInt32LE(size - WAV_HEADER);
    writeSync(fd, dataSize, 0, 4, 40);
  } finally {
    closeSync(fd);
  }
}

export function repairSessionWavs(sessionDir: string): void {
  repairWavHeader(join(sessionDir, "mic.wav"));
  repairWavHeader(join(sessionDir, "system.wav"));
}

function placeholderHeader(): Buffer {
  const header = Buffer.alloc(WAV_HEADER);
  header.write("RIFF", 0);
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(0, 40);
  return header;
}

export function createPcmWavWriter(filePath: string) {
  const fd = openSync(filePath, "w");
  writeSync(fd, placeholderHeader());
  return {
    write(pcm: Buffer): void {
      if (pcm.length === 0) return;
      writeSync(fd, pcm);
    },
    close(): void {
      closeSync(fd);
      repairWavHeader(filePath);
    },
  };
}
