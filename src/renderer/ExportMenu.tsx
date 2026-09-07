import { useEffect, useId, useRef, useState } from 'react';
import type { ExportFormat } from '../shared/types';

export function ExportMenu({ disabled, reason, exporting, onExport }: {
  disabled: boolean; reason: string; exporting: ExportFormat | null; onExport: (format: ExportFormat) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  function close(focus = false) { setOpen(false); if(focus) trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    const outside = (event: PointerEvent) => { if(!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown',outside);
    return () => document.removeEventListener('pointerdown',outside);
  },[open]);
  useEffect(() => { if(disabled || exporting) setOpen(false); },[disabled,exporting]);
  return <div className="export-menu" ref={box} onKeyDown={event => {
    if(event.key === 'Escape' && open) { event.preventDefault();close(true); }
    if(event.key === 'Tab' && open) close(true);
    if(!open || !['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const items=Array.from(box.current!.querySelectorAll<HTMLButtonElement>('[role=menuitem]'));
    const index=items.indexOf(document.activeElement as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
    items[next]?.focus();
  }}>
    <button ref={trigger} type="button" className="btn ghost" title={reason} disabled={disabled || Boolean(exporting)}
      aria-haspopup="menu" aria-controls={id} aria-expanded={open} onClick={() => setOpen(!open)}
      onKeyDown={event => {if(!open && ['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();setOpen(true);}}}>
      {exporting ? '导出中…' : '导出'}
    </button>
    {open && <div className="export-options" id={id} role="menu" aria-label="导出文件格式">
      <button type="button" role="menuitem" onClick={() => {close(true);onExport('txt');}}>纯文本 TXT</button>
      <button type="button" role="menuitem" onClick={() => {close(true);onExport('json');}}>结构化 JSON</button>
    </div>}
  </div>;
}
