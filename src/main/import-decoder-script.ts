/** Executed only inside a fresh sandboxed, network-denied Chromium renderer. */
export const IMPORT_DECODER_INIT = `window.__earshotImport = { chunks: [] }; true;`;
export const IMPORT_DECODER_DECODE = `(async () => {
  const state = window.__earshotImport;
  const blob = new Blob(state.chunks); state.chunks = [];
  const url = URL.createObjectURL(blob);
  const media = new Audio(); media.preload = 'metadata';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('无法读取音频时长')), 15000);
      media.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
      media.onerror = () => { clearTimeout(timer); reject(new Error('该音频编码暂不支持，请转换为 WAV、MP3 或 M4A 后重试')); };
      media.src = url;
    });
    if (!Number.isFinite(media.duration) || media.duration <= 0) throw new Error('无法读取音频时长');
    if (media.duration > 1800) throw new Error('音频最长 30 分钟；请先分段再导入');
    // Decode at the final sample rate, reducing decoded memory and avoiding a second full resample.
    const context = new OfflineAudioContext(1, 1, 16000);
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (decoded.duration > 1800 || decoded.numberOfChannels > 8 || decoded.length * decoded.numberOfChannels * 4 > 256 * 1024 * 1024) {
      throw new Error('音频解码后过大；请转换为单声道或分段后重试');
    }
    if (decoded.sampleRate !== 16000 || decoded.length <= 0) throw new Error('无法将音频转换为 16 kHz');
    state.decoded = decoded;
    return { durationSec: decoded.length / 16000, samples: decoded.length, channels: decoded.numberOfChannels };
  } finally {
    media.pause(); media.removeAttribute('src'); media.load(); URL.revokeObjectURL(url);
  }
})()`;

export function importDecoderChunk(offset: number, length: number): string {
  return `(() => {
    const audio = window.__earshotImport.decoded;
    const start = ${offset}, size = ${length};
    const pcm = new ArrayBuffer(size * 2), view = new DataView(pcm);
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
    for (let i = 0; i < size; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[start + i] / channels.length;
      sample = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
      view.setInt16(i * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
    }
    return new Uint8Array(pcm);
  })()`;
}
