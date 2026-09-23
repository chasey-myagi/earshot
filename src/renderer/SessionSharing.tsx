import { useEffect, useId, useRef, useState } from "react";
import type { CopyTranscriptInput, ExportFormat } from "../shared/types";

export function SessionSharing({ sessionId, available, why, exporting, onExport }: {
  sessionId: string;
  available: boolean;
  why: string;
  exporting: ExportFormat | null;
  onExport: (format: ExportFormat) => void;
}) {
  const [state, setState] = useState<"idle" | "busy" | "agent" | "text">("idle");
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<"closed" | "open" | "closing">("closed");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const menuId = useId();
  const errorId = useId();
  const disabled = !available || state === "busy" || exporting !== null;
  const success = state === "agent" || state === "text";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(feedbackTimer.current);
      clearTimeout(closeTimer.current);
    };
  }, []);

  function closeMenu(restoreFocus = false) {
    if (restoreFocus) trigger.current?.focus();
    setMenu("closing");
    clearTimeout(closeTimer.current);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const duration = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dropdown-close-dur")) || 150;
    closeTimer.current = setTimeout(() => setMenu("closed"), reduced ? 0 : duration);
  }

  function openMenu(last = false) {
    clearTimeout(closeTimer.current);
    // Keep the resting frame measurable so the opening transition runs.
    if (menuEl.current) void menuEl.current.offsetWidth;
    setMenu("open");
    const items = menuEl.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    // Focus after React removes inert, without leaving a timer after unmount.
    queueMicrotask(() => {
      if (mounted.current) items?.[last ? items.length - 1 : 0]?.focus();
    });
  }

  useEffect(() => {
    if (menu !== "open") return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) closeMenu();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);

  async function copy(kind: CopyTranscriptInput["kind"]) {
    if (busy.current || disabled) return;
    busy.current = true;
    clearTimeout(feedbackTimer.current);
    setState("busy");
    setError(null);
    try {
      const result = await window.earshot.copyTranscript({ sessionId, kind });
      if (!mounted.current) return;
      if (!result.ok) {
        setState("idle");
        setError(result.error);
      } else {
        setState(kind);
        feedbackTimer.current = setTimeout(() => setState("idle"), 2200);
      }
    } catch {
      if (mounted.current) {
        setState("idle");
        setError("复制没完成，请重试");
      }
    } finally {
      busy.current = false;
    }
  }

  return (
    <div className="session-sharing" ref={root} onKeyDown={(event) => {
      if (menu === "open" && event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); closeMenu(true);
      }
    }} onBlur={(event) => {
      if (menu === "open" && !event.currentTarget.contains(event.relatedTarget)) closeMenu();
    }}>
      <button type="button" className="btn ghost copy-agent" disabled={disabled}
        title={available ? "复制本地转录路径，供本机 Agent 读取；内容会自动更新" : why}
        aria-describedby={error ? errorId : undefined}
        aria-label={state === "busy" ? "复制中" : "复制给 Agent"}
        onClick={() => void copy("agent")}>
        <span className="t-icon-swap" data-state={success ? "b" : "a"} aria-hidden="true">
          <span className="t-icon" data-icon="a"><svg viewBox="0 0 20 20"><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M12 4V3H3v9h1" /></svg></span>
          <span className="t-icon" data-icon="b"><svg viewBox="0 0 20 20"><path d="m4 10 4 4 8-8" /></svg></span>
        </span>
        <span>{success ? (state === "text" ? "全文已复制" : "已复制") : state === "busy" ? "复制中…" : "复制给 Agent"}</span>
      </button>
      <span className="sr-only" role="status">{success ? (state === "text" ? "全文已复制" : "已复制，粘贴给本机 Agent 即可") : ""}</span>
      <button ref={trigger} type="button" className="btn ghost more-actions" aria-label="更多操作"
        title="更多操作" aria-haspopup="menu" aria-expanded={menu === "open"} aria-controls={menuId}
        onClick={() => menu === "open" ? closeMenu(true) : openMenu()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); openMenu(event.key === "ArrowUp");
          }
        }}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1" /><circle cx="10" cy="10" r="1" /><circle cx="16" cy="10" r="1" /></svg></button>
      <div ref={menuEl} id={menuId} role="menu" aria-label="会话操作" aria-hidden={menu !== "open"}
        inert={menu !== "open"} data-origin="top-right"
        className={`share-menu t-dropdown${menu === "open" ? " is-open" : menu === "closing" ? " is-closing" : ""}`}
        onKeyDown={(event) => {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && items.length) {
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }
        }}>
        <button type="button" role="menuitem" disabled={disabled} onClick={() => { closeMenu(true); void copy("text"); }}>复制全文</button>
        <div className="share-menu-divider" role="separator" />
        {(["txt", "json"] as const).map((format) => <button key={format} type="button" role="menuitem" disabled={disabled}
          title={why} onClick={() => { closeMenu(true); onExport(format); }}>
          {exporting === format ? "导出中…" : `导出 ${format.toUpperCase()}…`}
        </button>)}
      </div>
      {error ? <p id={errorId} className="share-error" role="alert">{error}</p> : null}
    </div>
  );
}
