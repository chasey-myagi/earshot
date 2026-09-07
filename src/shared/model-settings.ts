/** Explicit Qwen-family options, verified against the Beijing DashScope catalog 2026-09-07. */
export const DICTATION_MODELS = [
  { id: 'qwen-audio-3.0-asr-flash-streaming', label: 'Qwen Audio 3.0 ASR', price: '约 ¥1.19 / 小时' },
  { id: 'qwen3-asr-flash-realtime', label: 'Qwen3 ASR', price: '约 ¥1.19 / 小时' },
] as const;
export const POLISH_MODELS = [
  { id: 'off', label: '关闭' },
  { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash' },
  { id: 'qwen3.7-flash', label: 'Qwen3.7 Flash' },
  { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
] as const;
export type ModelPrefs = { asr: typeof DICTATION_MODELS[number]['id']; polish: typeof POLISH_MODELS[number]['id'] };
export const DEFAULT_MODELS: ModelPrefs = { asr: 'qwen-audio-3.0-asr-flash-streaming', polish: 'off' };
