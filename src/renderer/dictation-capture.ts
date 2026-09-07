import { floatToS16le, resampleFloat } from '../shared/pcm';
declare global { interface Window { dictationCapture: { ready: () => void; failed: () => void; pcm: (bytes: Uint8Array) => void } } }

const source = `class MicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) { const copy = channel.slice(); this.port.postMessage(copy, [copy.buffer]); }
    return true;
  }
} registerProcessor('dictation-mic', MicProcessor);`;

void (async () => {
  let stream: MediaStream | null = null, context: AudioContext | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    context = new AudioContext({ sampleRate: 16000 });
    await context.resume();
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const mic = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'dictation-mic', { channelCount: 1, channelCountMode: 'explicit' });
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const samples = context!.sampleRate === 16000 ? event.data : resampleFloat(event.data, context!.sampleRate, 16000);
      window.dictationCapture.pcm(floatToS16le(samples));
    };
    const mute = context.createGain(); mute.gain.value = 0;
    mic.connect(node); node.connect(mute); mute.connect(context.destination);
    stream.getAudioTracks()[0].onended = () => window.dictationCapture.failed();
    window.dictationCapture.ready();
    window.addEventListener('pagehide', () => { stream?.getTracks().forEach(track => track.stop()); void context?.close(); }, { once: true });
  } catch {
    stream?.getTracks().forEach(track => track.stop()); void context?.close();
    window.dictationCapture.failed();
  }
})();
