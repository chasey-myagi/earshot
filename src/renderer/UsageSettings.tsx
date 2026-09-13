import { ActionButton } from './ActionButton';
import { useEffect, useRef, useState } from 'react';
import type { UsagePeriod, UsageSummary } from '../shared/usage';
import './provider-settings.css';

const names: Record<string, string> = { 'fun-asr': '录音文件转写', 'fun-asr-realtime': '录中实时转写',
  'qwen-audio-3.0-asr-flash-streaming': 'Qwen Audio 3.0 语音输入', 'qwen3-asr-flash-realtime': 'Qwen3 ASR 语音输入',
  'qwen3.8-flash': 'Qwen3.8 Flash 文字整理', 'qwen3.7-flash': 'Qwen3.7 Flash 文字整理', 'qwen3.7-plus': 'Qwen3.7 Plus 文字整理', 'qwen-flash': 'Qwen Flash 录音标题' };
const money = (amount: number) => amount > 0 && amount < 0.01 ? '< ¥0.01' : `¥${amount.toFixed(2)}`;
const duration = (seconds: number) => seconds >= 3600 ? `${(seconds / 3600).toFixed(1)} 小时` : seconds >= 60 ? `${(seconds / 60).toFixed(1)} 分钟` : `${Math.round(seconds)} 秒`;

export function UsageSettings({ load, openBilling }: { load: (period: UsagePeriod) => Promise<UsageSummary>; openBilling: () => void }) {
  const [period, setPeriod] = useState<UsagePeriod>('month');
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    let active = true; setBusy(true); setError(null);
    void loadRef.current(period).then(value => { if (active) setSummary(value); }, () => { if (active) setError('用量统计未能读取，请重试'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [period, revision]);
  return <section className="settings-section" aria-labelledby="usage-heading">
    <div className="provider-settings-heading"><h3 id="usage-heading">用量与费用</h3><div className="provider-settings-actions">
      <select aria-label="用量时间范围" value={period} onChange={event => setPeriod(event.target.value as UsagePeriod)}>
        <option value="today">今天</option><option value="month">本月</option><option value="all">全部记录</option>
      </select><button type="button" className="field-link" disabled={busy} onClick={() => setRevision(value => value + 1)}>{busy ? '读取中…' : '刷新'}</button>
    </div></div>
    <div className="set-card provider-settings-body" aria-busy={busy}>
      {error ? <p role="alert" className="field-err">{error}</p> : null}
      {summary && summary.period === period ? <>
        <dl className="usage-overview">
          <div><dt>估算费用</dt><dd>{money(summary.estimatedCny)}{summary.unpricedRequests ? <small> + 未计价调用</small> : null}</dd></div>
          <div><dt>音频处理量</dt><dd>{duration(summary.audioSeconds)}</dd></div>
          <div><dt>模型请求</dt><dd>{summary.requests.toLocaleString()} <small>次</small></dd></div>
        </dl>
        {summary.requests ? <div className="usage-table-wrap"><table className="usage-table"><caption className="sr-only">本机各模型用量与估算费用</caption>
          <thead><tr><th scope="col">模型用途</th><th scope="col">用量</th><th scope="col">估算</th></tr></thead>
          <tbody>{summary.rows.map(row => <tr key={row.model}><th scope="row">{names[row.model] ?? row.model}<small>{row.requests} 次请求</small></th>
            <td>{row.audioSeconds ? duration(row.audioSeconds) : `${row.inputTokens.toLocaleString()} 入 / ${row.outputTokens.toLocaleString()} 出 Token`}</td>
            <td>{row.unpricedRequests === row.requests ? '—' : money(row.estimatedCny)}{row.unpricedRequests ? <small>{row.unpricedRequests} 次未计价</small> : null}</td></tr>)}</tbody>
        </table></div> : <p className="settings-caption">所选时段暂无用量记录。</p>}
        {summary.error ? <p className="field-err" role="alert">{summary.error}</p> : null}
        {summary.unconfirmedRequests > 0 ? <p className="settings-caption">{summary.unconfirmedRequests} 次请求未收到完成确认，估算费用不代表实际扣费。</p> : null}
        <details className="settings-caption settings-note usage-details"><summary>统计说明</summary>
          <p>自 {new Date(summary.trackingSince).toLocaleDateString()} 起记录。录中转写、结束后转写和重试分别计量；删除会话不会删除用量记录。</p>
          <p>优先使用百炼返回的用量，{summary.localMeasuredRequests} 次请求使用本机发送时长或缺少云端计量。文字整理和录音标题按服务返回的 Token 统计，缺少计量时显示“未计价”。未收到完成确认的请求，无法据此判断是否扣费。</p>
          <p>按 {summary.pricingDate} 百炼北京地域公开原价估算，未扣除免费额度、缓存折扣和优惠。保留最近 {summary.retentionDays} 天、最多 10,000 次请求。{summary.capped ? '已达记录上限，更早记录已移出统计。' : ''}</p>
        </details>
      </> : !error ? <p className="settings-caption">正在读取本机用量…</p> : null}
    </div>
    <div className="usage-footer"><p className="settings-caption">仅统计这台 Mac，实际费用以百炼账单为准。</p><ActionButton className="field-link" action={async () => { await openBilling(); }} failure="未能打开百炼账单，请重试">查看百炼账单</ActionButton></div>
  </section>;
}
