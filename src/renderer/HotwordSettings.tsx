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
  const request = useRef(0);
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
      void loadRef.current().then(value => { if (mounted.current && ticket === request.current) accept(value); }, () => {
        if (mounted.current && ticket === request.current) setError('热词未能读取，请重新打开设置');
      });
    }
    refresh();
    const unsubscribe = subscribe?.(refresh);
    return () => { mounted.current = false; request.current += 1; unsubscribe?.(); };
  }, [subscribe]);
  let count = 0, validation: string | null = null;
  try { count = normalizeHotwords(draft).length; } catch (err) { validation = err instanceof Error ? err.message : '热词内容无效'; }
  const dirty = status && draft !== status.words.join('\n');
  async function apply(retry = false) {
    if (busy) return; setBusy(true); setError(null); request.current += 1;
    try {
      const value = await (retry ? sync() : save(draft));
      if (mounted.current) { request.current += 1; accept(value, !retry); }
    } catch { setError('热词未能保存，请重试'); }
    finally { setBusy(false); }
  }
  return <section className="settings-section" aria-labelledby="hotwords-heading">
    <h3 id="hotwords-heading">个人热词</h3>
    <div className="set-card provider-settings-body">
      <label htmlFor="personal-hotwords">人名、公司名与专业术语</label>
      <p className="why" id="hotwords-help">每行一个，最多 {HOTWORD_LIMIT} 个。保存后供后续转写复用；词表会随转写或同步发送到百炼。</p>
      <textarea id="personal-hotwords" aria-describedby="hotwords-help hotwords-validation" rows={5} maxLength={30000}
        placeholder={'例如：\n矩阵起源\nMatrixOne\nEarshot'} value={draft} disabled={!status || busy} onChange={event => { form.current.draft = event.target.value; setDraft(event.target.value); }} />
      <div className="provider-settings-actions">
        <span className="settings-caption">{validation ?? `${count} / ${HOTWORD_LIMIT} 个`}</span>
        <button type="button" className="btn ghost" disabled={!status || !dirty || busy || Boolean(validation)} onClick={() => void apply()}>{busy ? '保存与同步中…' : '保存热词'}</button>
      </div>
      <p id="hotwords-validation" className="field-err" role={validation || error ? 'alert' : undefined}>{validation ?? error}</p>
      {status ? <>
        <div className="hotword-status" role="status">{status.message ?? (status.sync === 'empty' ? '尚未设置热词' : status.sync === 'ready' ? '已保存，支持的转写模型均已就绪' : '已保存到本机，录音词表待同步')}
          {status.words.length > 0 && status.sync !== 'ready' ? <button type="button" className="field-link" disabled={busy || Boolean(dirty)} onClick={() => void apply(true)}>重试同步</button> : null}
        </div>
        {status.words.length > 0 ? <ul className="hotword-models">{status.models.map(model => <li key={model.model}><span>{model.label}</span><span>{!model.supported ? '此模型不支持热词' : model.ready ? '就绪' : '待同步'}</span></li>)}</ul> : null}
      </> : null}
    </div>
    <p className="settings-caption">含中文的词最多 15 个字，英文最多 7 个单词。清空后保存可停用热词；云端旧词表仍会保留并占用额度，可在任务结束后通过百炼管理。</p>
  </section>;
}
