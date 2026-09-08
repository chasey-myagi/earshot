import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { AUDIO_IMPORT_LIMITS, type AudioDecoder } from './import-audio.ts';
import { IMPORT_DECODER_INIT, IMPORT_DECODER_DECODE, importDecoderChunk } from './import-decoder-script.ts';

/** Fresh renderer per import; no microphone, network, source filesystem, preload or Node access. */
export const decodeWithChromium: AudioDecoder = async (path, options) => {
  const check = () => { if (options.signal.aborted) throw new Error('已取消导入'); };
  check();
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > AUDIO_IMPORT_LIMITS.bytes) throw new Error('单个音频最多 64 MB');
  const isolated = session.fromPartition(`earshot-import-${randomUUID()}`);
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:text/html,') }));
  isolated.on('will-download', event => event.preventDefault());
  const window = new BrowserWindow({ width: 1, height: 1, show: false, focusable: false, skipTaskbar: true,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  let rejectEnded: (reason: Error) => void = () => {};
  const ended = new Promise<never>((_resolve, reject) => { rejectEnded = reject; });
  const abort = () => { rejectEnded(new Error('已取消导入')); if (!window.isDestroyed()) window.destroy(); };
  options.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { rejectEnded(new Error('音频转换超时；请分段后重试')); if (!window.isDestroyed()) window.destroy(); }, 180000);
  window.webContents.once('render-process-gone', () => rejectEnded(new Error('音频转换进程已停止；请转换为较小的音频后重试')));
  window.once('closed', () => rejectEnded(new Error('音频转换已停止')));
  async function run() {
    check();
    const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src blob:; connect-src 'none'; script-src 'none'"><title>Earshot audio import</title>`;
    await window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    await window.webContents.executeJavaScript(IMPORT_DECODER_INIT);
    let copied = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: AUDIO_IMPORT_LIMITS.chunkBytes })) {
      check(); copied += chunk.length;
      if (copied > info.size || copied > AUDIO_IMPORT_LIMITS.bytes) throw new Error('音频文件在转换时发生变化');
      // Base64 consists only of literal-safe characters. At most one 256 KiB IPC chunk is in flight.
      await window.webContents.executeJavaScript(`window.__earshotImport.chunks.push(Uint8Array.from(atob('${(chunk as Buffer).toString('base64')}'), c => c.charCodeAt(0))); true;`);
      options.onProgress?.(copied / info.size * 20);
    }
    if (copied !== info.size) throw new Error('音频文件在转换时发生变化');
    check();
    const result = await window.webContents.executeJavaScript(IMPORT_DECODER_DECODE) as { durationSec: number; samples: number; channels: number };
    if (!Number.isInteger(result.samples) || result.samples <= 0 || result.samples > AUDIO_IMPORT_LIMITS.durationSec * AUDIO_IMPORT_LIMITS.sampleRate ||
      result.durationSec !== result.samples / AUDIO_IMPORT_LIMITS.sampleRate) throw new Error('音频转换结果无效');
    for (let offset = 0; offset < result.samples; offset += AUDIO_IMPORT_LIMITS.chunkBytes / 2) {
      check();
      const length = Math.min(AUDIO_IMPORT_LIMITS.chunkBytes / 2, result.samples - offset);
      const chunk = await window.webContents.executeJavaScript(importDecoderChunk(offset, length));
      check();
      if (!(chunk instanceof Uint8Array) || chunk.byteLength !== length * 2) throw new Error('音频转换数据不完整');
      options.onPCM(chunk);
      options.onProgress?.(20 + (offset + length) / result.samples * 80);
    }
    return { durationSec: result.durationSec };
  }
  try { return await Promise.race([run(), ended]); }
  finally {
    clearTimeout(timer); options.signal.removeEventListener('abort', abort);
    if (!window.isDestroyed()) window.destroy();
    isolated.webRequest.onBeforeRequest(null);
    await isolated.clearStorageData();
  }
};
