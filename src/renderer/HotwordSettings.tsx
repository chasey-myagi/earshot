import { useEffect, useRef, useState } from 'react';
import { HOTWORD_LIMIT, normalizeHotwords, type HotwordStatus } from '../shared/hotwords';
import './provider-settings.css';

export function HotwordSettings({ load, save, sync, subscribe }: {
  load: () => Promise<HotwordStatus>;
  save: (text: string) => Promise<HotwordStatus>;
  sync: () => Promise<HotwordStatus>;
  subscribe?: (changed: () => void) => () => void;
}) {
  const [status, setStatus] = useState<HotwordStatus | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load); loadRef.current = load;
  const form = useRef({ draft: '', saved: '' });
  const request = useRef(0), applying = useRef(false);
  const [retryLoad, setRetryLoad] = useState(0);
  const mounted = useRef(false);
  function accept(value: HotwordStatus, replaceDraft = false) {
    const dirty = form.current.draft !== form.current.saved;
    setStatus(value);
    form.current.saved = value.words.join('\n');
    if (!dirty || replaceDraft) { form.current.draft = form.current.saved; setDraft(form.current.saved); }
  }
  useEffect(() => {
    mounted.current = true;
    function refresh() {
      const ticket = ++request.current;
      void loadRef.current().then(value => { if (mounted.current && ticket === request.current) { accept(value); setError(null); } }, () => {
        if (mounted.current && ticket === request.current) setError('热词未能读取，请重试');
      });
    }
    refresh();
    const unsubscribe = subscribe?.(refresh);
    return () => { mounted.current = false; request.current += 1; unsubscribe?.(); };
  }, [subscribe, retryLoad]);
  let count = 0, validation: string | null = null;
  try { count = normalizeHotwords(draft).length; } catch (err) { validation = err instanceof Error ? err.message : '热词内容无效'; }
  const dirty = status && draft !== status.words.join('\n');
  async function apply(retry = false) {
    if (applying.current) return; applying.current = true; setBusy(true); setError(null); request.current += 1;
    try {
      const value = await (retry ? sync() : save(draft));
      if (mounted.current) { request.current += 1; accept(value, !retry); }
    } catch { if (mounted.current) setError(retry ? '同步未完成，热词仍保留在本机。请重试。' : '热词未能保存，请重试'); }
    finally { applying.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="settings-section" aria-labelledby="hotwords-heading">
    <h3 id="hotwords-heading">个人热词</h3>
    <div className="set-card provider-settings-body">
      <label htmlFor="personal-hotwords">人名、公司名与专业术语</label>
      <p className="why" id="hotwords-help">每行一个，最多 {HOTWORD_LIMIT} 个。热词会发送到百炼，用于后续转写。</p>
      <textarea aria-invalid={Boolean(validation)} id="personal-hotwords" aria-describedby="hotwords-help hotwords-validation" rows={4} maxLength={30000}
        placeholder={'例如：\n林晓\n向日葵工作室\n声纹识别'} value={draft} disabled={!status || busy} onChange={event => { form.current.draft = event.target.value; setDraft(event.target.value); }} />
      <div className="provider-settings-actions">
        <span className="settings-caption">{validation ?? `${count} / ${HOTWORD_LIMIT} 个`}</span>
        <button type="button" className="btn ghost" disabled={!status || !dirty || busy || Boolean(validation)} onClick={() => void apply()}>{busy ? '保存中…' : '保存热词'}</button>
      </div>
      <p id="hotwords-validation" className="field-err" role={validation || error ? 'alert' : undefined}>{validation ?? error}</p>
      {!status && error && <button type="button" className="btn ghost" onClick={() => { setError(null); setRetryLoad(value => value + 1); }}>重新读取热词</button>}
      {status && (status.words.length > 0 || status.updatedAt !== null || status.message) ? <>
        <div className="hotword-status" role="status">{status.message ?? (status.sync === 'empty' ? '已停用' : status.sync === 'ready' ? '已保存' : '已保存，部分模型待同步')}
          {status.words.length > 0 && status.sync !== 'ready' ? <button type="button" className="field-link" disabled={busy || Boolean(dirty)} onClick={() => void apply(true)}>重试同步</button> : null}
        </div>
        {status.words.length > 0 ? <details className="settings-caption settings-note hotword-model-details"><summary>模型支持情况</summary><ul className="hotword-models">{status.models.map(model => <li key={model.model}><span>{model.label}</span><span>{!model.supported ? '不支持热词' : model.ready ? '已就绪' : '待同步'}</span></li>)}</ul></details> : null}
      </> : null}
    </div>
    <details className="settings-caption settings-note"><summary>填写与停用说明</summary>
      <p>每条含中文的热词最多 15 个字，纯英文最多 7 个单词、100 个字符。清空后保存即可停用。</p>
      <p>停用不会删除百炼上的旧词表，旧词表仍占用额度。可在转写任务结束后到百炼控制台管理。</p>
    </details>
  </section>;
}
