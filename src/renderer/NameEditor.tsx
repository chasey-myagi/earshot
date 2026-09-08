import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Small, contextual naming form shared by session and speaker editors. */
export function NameEditor({ label, value, original, maxLength, busy, error, hint, children, allowUnchanged = false, saveLabel = '保存', onChange, onSave, onCancel }: {
  label: string; value: string; original: string; maxLength: number; busy: boolean;
  error?: string | null; hint?: string; children?: ReactNode; allowUnchanged?: boolean; saveLabel?: string;
  onChange: (value: string) => void; onSave: () => void; onCancel: () => void;
}) {
  const id = useId(), input = useRef<HTMLInputElement>(null), composing = useRef(false);
  const canSave = Boolean(value.trim()) && (allowUnchanged || value.trim() !== original.trim());
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  return <form className="name-editor" aria-label={`修改${label}`} aria-busy={busy} onSubmit={event => {
    event.preventDefault(); if (!busy && !composing.current && canSave) onSave();
  }} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) {
      if (event.key === 'Enter') event.preventDefault(); return;
    }
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); if (!busy && canSave) onSave(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); }
  }}>
    <label htmlFor={id}>{label}</label>
    {hint && <p className="name-editor-hint" id={`${id}-hint`}>{hint}</p>}
    <input id={id} ref={input} value={value} maxLength={maxLength} readOnly={busy} autoComplete="off"
      aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined} aria-invalid={Boolean(error)}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onChange={event => onChange(event.target.value)} />
    {children}
    {error && <p className="name-editor-error" id={`${id}-error`} role="alert">{error}</p>}
    <div className="name-editor-actions">
      <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>取消</button>
      <button type="submit" className="btn primary" disabled={busy || !canSave}>{busy ? '保存中…' : saveLabel}</button>
    </div>
  </form>;
}
