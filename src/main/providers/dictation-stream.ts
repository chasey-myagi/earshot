import { randomUUID } from 'node:crypto';
import { defaultSocketConnect, parseRealtimeMessage, type SocketConnect } from './realtime.ts';
import type { ModelPrefs } from '../../shared/model-settings';

/** Capture can start while the socket opens. Buffered frames drain as soon as the task is ready. */
export function startDictationStream(opts: { apiKey: string; model: ModelPrefs['asr']; signal: AbortSignal; connect?: SocketConnect }) {
  const qwen3 = opts.model === 'qwen3-asr-flash-realtime';
  const url = qwen3 ? `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${opts.model}` : 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
  const socket = (opts.connect ?? defaultSocketConnect)(url, { Authorization: `Bearer ${opts.apiKey}`, ...(qwen3 ? { 'OpenAI-Beta': 'realtime=v1' } : {}) });
  const taskId = randomUUID(), sentences = new Map<string, { text: string; time: number }>();
  let ready = false, ending = false, settled = false, sent = 0, anonymous = 0;
  let queue: Buffer[] = [], queuedBytes = 0;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (text: string) => void, reject!: (error: Error) => void;
  const result = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  void result.catch(() => {}); // A connection can fail while the user is still speaking.
  const timer = setTimeout(() => done(new Error('识别超时，请重试')), 110000);
  function done(error?: Error) {
    if (settled) return; settled = true; clearTimeout(timer); clearTimeout(finishTimer); opts.signal.removeEventListener('abort', abort);
    for (const bytes of queue) bytes.fill(0); queue = [];
    try { socket.close(); } catch { /* disconnected */ }
    if (error) reject(error); else resolve([...sentences.values()].sort((a, b) => a.time - b.time).map(s => s.text).join('').trim());
  }
  function json(value: unknown) { socket.send(JSON.stringify(value)); }
  function flush() {
    if (!ready || settled) return;
    try {
      for (const bytes of queue) { if (qwen3) json({ event_id: randomUUID(), type: 'input_audio_buffer.append', audio: bytes.toString('base64') }); else socket.send(bytes); }
      queue = []; queuedBytes = 0;
      if (ending) {
        if (qwen3) { json({ event_id: randomUUID(), type: 'input_audio_buffer.commit' }); json({ event_id: randomUUID(), type: 'session.finish' }); }
        else json({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } });
        ready = false;
      }
    } catch { done(new Error('识别连接中断，请重试')); }
  }
  const abort = () => done(new Error('已取消'));
  opts.signal.addEventListener('abort', abort, { once: true });
  if (opts.signal.aborted) abort();
  socket.onOpen(() => {
    if (settled) return;
    try {
      if (qwen3) json({ event_id: randomUUID(), type: 'session.update', session: { modalities: ['text'], input_audio_format: 'pcm', sample_rate: 16000, turn_detection: null } });
      else json({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' }, payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: opts.model, parameters: { format: 'pcm', sample_rate: 16000 }, input: {} } });
    } catch { done(new Error('识别连接失败，请重试')); }
  });
  socket.onMessage(raw => {
    if (settled) return;
    try {
      if (qwen3) {
        const message = JSON.parse(raw);
        if (message.type === 'session.updated') { ready = true; flush(); }
        else if (message.type === 'conversation.item.input_audio_transcription.completed') sentences.set(message.item_id ?? `${anonymous++}`, { text: String(message.transcript ?? ''), time: anonymous++ });
        else if (message.type === 'session.finished') done();
        else if (message.type === 'error' || message.type === 'conversation.item.input_audio_transcription.failed') done(new Error('识别服务未能完成，请检查密钥、额度或网络'));
      } else {
        const message = parseRealtimeMessage(raw);
        if (message.event === 'task-started') { ready = true; flush(); }
        else if (message.sentence?.final) sentences.set(message.sentence.sentenceId || `${anonymous++}`, { text: message.sentence.text, time: message.sentence.tStartMs });
        else if (message.event === 'task-finished') done();
        else if (message.event === 'task-failed') done(new Error('识别服务未能完成，请检查密钥、额度或网络'));
      }
    } catch { /* ignore malformed provider messages */ }
  });
  socket.onError(() => done(new Error('识别连接失败，请重试')));
  socket.onClose(() => { if (!settled) done(new Error('识别连接中断，请重试')); });
  return {
    send(bytes: Buffer) { if (settled || ending) return; if (bytes.length % 2 || sent + bytes.length > 32000 * 60) { done(new Error('录音长度无效')); return; } sent += bytes.length; queue.push(Buffer.from(bytes)); queuedBytes += bytes.length; if (queuedBytes >= 3200) flush(); },
    finish() { if (!ending && !settled) { ending = true; finishTimer = setTimeout(() => done(new Error('识别超时，请重试')), 15000); flush(); } return result; },
  };
}
