import type { Track } from "./types";

export const PCM_RATE = 16000;
export const FRAME_SAMPLES = 2048;

export type CapturedFrame = {
  track: Track;
  pcm: Uint8Array;
};

export function floatToS16le(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    const value = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(i * 2, value, true);
  }
  return out;
}

export function resampleFloat(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0 || input.length === 0) return input;
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const src = i * ratio;
    const index = Math.floor(src);
    const frac = src - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function encodeCaptureFrames(
  track: Track,
  pending: Float32Array,
  incoming: Float32Array,
  frameSamples = FRAME_SAMPLES,
): { frames: CapturedFrame[]; rest: Float32Array } {
  const total = pending.length + incoming.length;
  if (total === 0) return { frames: [], rest: pending };
  const combined = new Float32Array(total);
  combined.set(pending, 0);
  combined.set(incoming, pending.length);
  const frames: CapturedFrame[] = [];
  let offset = 0;
  while (offset + frameSamples <= combined.length) {
    frames.push({
      track,
      pcm: floatToS16le(combined.subarray(offset, offset + frameSamples)),
    });
    offset += frameSamples;
  }
  return { frames, rest: combined.subarray(offset) };
}
