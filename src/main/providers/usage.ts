import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeJson } from '../store/json.ts';
import type { UsageEvent, UsagePeriod, UsageSummary } from '../../shared/usage.ts';

export const PRICING_DATE = '2026-09-08';
export const PRICING_SOURCE = 'https://help.aliyun.com/zh/model-studio/model-pricing';
export const BILLING_SOURCE = 'https://help.aliyun.com/zh/model-studio/bill-query-and-cost-management';
export const BALANCE_SOURCE = 'https://help.aliyun.com/zh/user-center/bill-view';
const RETENTION_DAYS = 366, MAX_EVENTS = 10_000;
const ASR_PRICES: Record<string, number> = { 'fun-asr': 0.00022, 'fun-asr-realtime': 0.00033,
  'qwen-audio-3.0-asr-flash-streaming': 0.00033, 'qwen3-asr-flash-realtime': 0.00033 };
const MODELS = [...Object.keys(ASR_PRICES), 'qwen3.8-flash', 'qwen3.7-flash', 'qwen3.7-plus'];
const positive = (value: unknown, cap: number) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= cap ? value : undefined;

/** Only documented response fields; never infer token counts from text length. */
export function parseUsage(raw: unknown): { audioSeconds?: number; inputTokens?: number; outputTokens?: number } {
  if (!raw || typeof raw !== 'object') return {};
  const root = raw as Record<string, any>;
  const usage = root.usage ?? root.payload?.usage ?? root.payload?.output?.usage;
  if (!usage || typeof usage !== 'object') return {};
  const audioSeconds = positive(usage.duration, 172_800);
  const inputTokens = positive(usage.prompt_tokens ?? usage.input_tokens, 10_000_000);
  const outputTokens = positive(usage.completion_tokens ?? usage.output_tokens, 10_000_000);
  return { ...(audioSeconds !== undefined ? { audioSeconds } : {}), ...(Number.isInteger(inputTokens) ? { inputTokens } : {}), ...(Number.isInteger(outputTokens) ? { outputTokens } : {}) };
}

export function estimateCny(event: UsageEvent): number | null {
  const audioRate = ASR_PRICES[event.model];
  if (audioRate !== undefined) return event.audioSeconds === undefined ? null : event.audioSeconds * audioRate;
  if (event.inputTokens === undefined || event.outputTokens === undefined) return null;
  const input = event.inputTokens, output = event.outputTokens;
  if (event.model === 'qwen3.8-flash') return (input + output * 3) / 1_000_000;
  if (event.model === 'qwen3.7-flash') {
    const rate = input <= 32768 ? [0.2, 0.8] : input <= 262144 ? [0.6, 2.4] : [1.2, 4.8];
    return (input * rate[0] + output * rate[1]) / 1_000_000;
  }
  if (event.model === 'qwen3.7-plus') {
    const rate = input <= 262144 ? [2, 8] : [6, 24];
    return (input * rate[0] + output * rate[1]) / 1_000_000;
  }
  // Keep unsupported pricing unknown rather than applying another model's price.
  return null;
}

function validEvent(raw: unknown): raw is UsageEvent {
  if (!raw || typeof raw !== 'object') return false;
  const row = raw as UsageEvent;
  return typeof row.id === 'string' && /^[a-f0-9]{64}$/.test(row.id) && Number.isSafeInteger(row.at) && row.at > 0
    && MODELS.includes(row.model) && ['file-asr', 'realtime-asr', 'dictation-asr', 'polish'].includes(row.kind)
    && ['provider', 'local'].includes(row.measurement) && (!row.outcome || ['succeeded', 'uncertain'].includes(row.outcome))
    && (row.audioSeconds === undefined || positive(row.audioSeconds, 172_800) !== undefined)
    && (row.inputTokens === undefined || (Number.isInteger(row.inputTokens) && positive(row.inputTokens, 10_000_000) !== undefined))
    && (row.outputTokens === undefined || (Number.isInteger(row.outputTokens) && positive(row.outputTokens, 10_000_000) !== undefined));
}

export function createUsageLedger(path: string, now: () => number = Date.now) {
  let trackingSince = now(), events: UsageEvent[] = [], capped = false, error: string | undefined;
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (raw.version !== 1 || !Number.isSafeInteger(raw.trackingSince) || !Array.isArray(raw.events) || raw.events.length > MAX_EVENTS || !raw.events.every(validEvent) || new Set(raw.events.map((event: UsageEvent) => event.id)).size !== raw.events.length) throw new Error();
      trackingSince = raw.trackingSince; events = raw.events; capped = raw.capped === true;
    } catch { error = '本机用量记录无法读取，统计不完整；原文件已保留。'; }
  }
  let unreadable = Boolean(error);
  function record(input: UsageEvent): void {
    if (unreadable) return;
    const event: UsageEvent = { id: createHash('sha256').update(`${input.kind}:${input.id}`).digest('hex'), at: input.at,
      model: input.model, kind: input.kind, measurement: input.measurement,
      ...(input.audioSeconds !== undefined ? { audioSeconds: input.audioSeconds } : {}),
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      outcome: input.outcome ?? 'succeeded' };
    if (!validEvent(event) || event.at > now() + 60_000) { error = '部分用量数据无效，未纳入统计。'; return; }
    const cutoff = now() - RETENTION_DAYS * 86_400_000;
    if (event.at < cutoff) return;
    const previous = events.find(row => row.id === event.id);
    if (previous) {
      event.at = previous.at;
      // Task duration in result-generated is cumulative, not an amount to add per sentence.
      if (previous.measurement === 'provider' && event.measurement === 'local') {
        event.audioSeconds = previous.audioSeconds; event.measurement = 'provider';
      } else if (previous.measurement === event.measurement && previous.audioSeconds !== undefined && event.audioSeconds !== undefined) {
        event.audioSeconds = Math.max(previous.audioSeconds, event.audioSeconds);
      }
      if (previous.outcome === 'succeeded') event.outcome = 'succeeded';
    }
    let next = events.filter(row => row.id !== event.id && row.at >= cutoff);
    next.push(event); next.sort((a, b) => a.at - b.at);
    if (next.length > MAX_EVENTS) { capped = true; next = next.slice(-MAX_EVENTS); }
    try {
      const firstAt = Math.min(trackingSince, event.at);
      writeJson(path, { version: 1, trackingSince: firstAt, capped, events: next }); events = next; trackingSince = firstAt;
      error = undefined;
    } catch { error = '本机用量记录未能保存，统计可能遗漏；转写结果不受影响。'; }
  }
  function summary(period: UsagePeriod = 'month'): UsageSummary {
    if (!['today', 'month', 'all'].includes(period)) throw new Error('用量时间范围无效');
    const current = now(), date = new Date(current);
    const since = period === 'today' ? new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
      : period === 'month' ? new Date(date.getFullYear(), date.getMonth(), 1).getTime()
      : Math.max(trackingSince, current - RETENTION_DAYS * 86_400_000);
    const selected = events.filter(row => row.at >= since && row.at <= current);
    const rows: UsageSummary['rows'] = [];
    for (const event of selected) {
      let row = rows.find(item => item.model === event.model);
      if (!row) { row = { model: event.model, requests: 0, audioSeconds: 0, inputTokens: 0, outputTokens: 0, estimatedCny: 0, unpricedRequests: 0 }; rows.push(row); }
      row.requests++; row.audioSeconds += event.audioSeconds ?? 0; row.inputTokens += event.inputTokens ?? 0; row.outputTokens += event.outputTokens ?? 0;
      const estimate = estimateCny(event); if (estimate === null) row.unpricedRequests++; else row.estimatedCny += estimate;
    }
    return { period, since, updatedAt: current, trackingSince, requests: selected.length,
      audioSeconds: rows.reduce((sum, row) => sum + row.audioSeconds, 0), inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0), outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
      estimatedCny: rows.reduce((sum, row) => sum + row.estimatedCny, 0), unpricedRequests: rows.reduce((sum, row) => sum + row.unpricedRequests, 0),
      localMeasuredRequests: selected.filter(row => row.measurement === 'local').length,
      unconfirmedRequests: selected.filter(row => row.outcome === 'uncertain').length,
      rows, actualBilling: 'unavailable', balanceCny: null,
      billingReason: '当前 DashScope API Key 仅用于模型调用。账单和账户余额查询需要阿里云财务 OpenAPI 的独立身份与权限，无法用此 Key 读取。',
      pricingDate: PRICING_DATE, retentionDays: RETENTION_DAYS, capped, ...(error ? { error } : {}) };
  }
  return { record, summary };
}
let current: ReturnType<typeof createUsageLedger> | undefined;
export function configureUsage(path: string): void { current = createUsageLedger(path); }
export function recordUsage(event: UsageEvent): void { try { current?.record(event); } catch { /* metering must never discard a transcript */ } }
export function getUsageSummary(period: UsagePeriod = 'month'): UsageSummary { if (!current) throw new Error('用量统计尚未就绪'); return current.summary(period); }
