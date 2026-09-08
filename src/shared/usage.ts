export type UsagePeriod = 'today' | 'month' | 'all';
export type UsageKind = 'file-asr' | 'realtime-asr' | 'dictation-asr' | 'polish';
export type UsageEvent = {
  id: string; at: number; model: string; kind: UsageKind;
  audioSeconds?: number; inputTokens?: number; outputTokens?: number;
  measurement: 'provider' | 'local';
  outcome?: 'succeeded' | 'uncertain';
};
export type UsageSummary = {
  period: UsagePeriod; since: number; updatedAt: number; trackingSince: number;
  requests: number; audioSeconds: number; inputTokens: number; outputTokens: number;
  estimatedCny: number; unpricedRequests: number; localMeasuredRequests: number; unconfirmedRequests: number;
  rows: { model: string; requests: number; audioSeconds: number; inputTokens: number; outputTokens: number; estimatedCny: number; unpricedRequests: number }[];
  actualBilling: 'unavailable'; balanceCny: null; billingReason: string;
  pricingDate: string; retentionDays: number; capped: boolean; error?: string;
};
