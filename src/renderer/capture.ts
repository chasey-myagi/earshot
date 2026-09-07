import { encodeCaptureFrames, FRAME_SAMPLES, PCM_RATE, resampleFloat } from "../shared/pcm";
import type { Track } from "../shared/types";

const leftover: Record<Track, Float32Array> = {
  you: new Float32Array(0),
  other: new Float32Array(0),
};

const PROCESSOR = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.frameSamples = opts.frameSamples || 2048;
    this.pending = new Float32Array(0);
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    const next = new Float32Array(this.pending.length + channel.length);
    next.set(this.pending);
    next.set(channel, this.pending.length);
    let offset = 0;
    while (offset + this.frameSamples <= next.length) {
      const frame = next.slice(offset, offset + this.frameSamples);
      this.port.postMessage(frame, [frame.buffer]);
      offset += this.frameSamples;
    }
    this.pending = next.slice(offset);
    return true;
  }
}
registerProcessor("capture-processor", CaptureProcessor);
`;

function workletUrl(): string {
  return URL.createObjectURL(new Blob([PROCESSOR], { type: "text/javascript" }));
}

async function openCaptureContext(): Promise<AudioContext> {
  try {
    const ctx = new AudioContext({ sampleRate: PCM_RATE });
    if (ctx.sampleRate === PCM_RATE) {
      await ctx.resume();
      return ctx;
    }
    await ctx.close();
  } catch {
    // Chromium 可能拒绝指定采样率；退回默认并在回调里用 resampleFloat
  }
  const fallback = new AudioContext();
  await fallback.resume();
  return fallback;
}

function onSamples(track: Track, samples: Float32Array, sourceRate: number): void {
  const at16k = sourceRate === PCM_RATE ? samples : resampleFloat(samples, sourceRate, PCM_RATE);
  const { frames, rest } = encodeCaptureFrames(track, leftover[track], at16k);
  leftover[track] = rest.length === 0 ? new Float32Array(0) : Float32Array.from(rest);
  for (const frame of frames) window.capture.sendPcm(frame.track, frame.pcm);
}

async function startTrack(context: AudioContext, track: Track, stream: MediaStream): Promise<void> {
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "capture-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    processorOptions: {
      frameSamples: Math.max(1, Math.round((context.sampleRate * FRAME_SAMPLES) / PCM_RATE)),
    },
  });
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (event.data && event.data.length > 0) onSamples(track, event.data, context.sampleRate);
  };
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(context.destination);
}

async function micStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      // 未真机验证是否消除系统声串扰
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

async function loopbackStream(sourceId: string): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxWidth: 2,
        maxHeight: 2,
      },
    },
  } as unknown as MediaStreamConstraints);
  for (const track of stream.getVideoTracks()) track.stop();
  return stream;
}

void (async () => {
  try {
    const { sourceId } = await window.capture.begin();
    const context = await openCaptureContext();
    await context.audioWorklet.addModule(workletUrl());
    let mic: MediaStream;
    try {
      mic = await micStream();
    } catch {
      throw new Error("需要麦克风权限");
    }
    let loopback: MediaStream;
    try {
      loopback = await loopbackStream(sourceId);
    } catch (err) {
      for (const track of mic.getTracks()) track.stop();
      throw new Error(err instanceof Error && err.message ? err.message : "需要屏幕录制权限");
    }
    await startTrack(context, "you", mic);
    await startTrack(context, "other", loopback);
    window.capture.ready();
  } catch (err) {
    window.capture.failed(err instanceof Error ? err.message : "采集没起来");
  }
})();
