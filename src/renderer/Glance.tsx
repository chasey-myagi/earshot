import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RecordingLive } from "../shared/types";
import { CloseIcon } from "./icons";
import { scrollBehavior, shouldStickToBottom } from "./scroll";
import { Turns } from "./Turns";
import { RecordingClock, RealtimeNotice, StopRecording } from "./RecordingControls";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof matchMedia !== "undefined" ? matchMedia("(prefers-reduced-motion: reduce)").matches : false,
  );

  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

type GlanceProps = {
  recording: RecordingLive | null;
};

export function Glance({ recording }: GlanceProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const reducedMotion = useReducedMotion();
  const turns = recording?.turns ?? [];
  const tail = turns[turns.length - 1];

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      stickRef.current = shouldStickToBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior(reducedMotion) });
  }, [turns.length, tail?.id, tail?.text, tail?.partial, reducedMotion]);

  return (
    <div className="glance">
      <header className="glance-bar">
        <button
          type="button"
          className="glance-close"
          title={recording?.phase === "finalize_failed" ? "隐藏浮窗，稍后可打开 Earshot 重试保存" : "隐藏浮窗，录音继续"}
          aria-label="隐藏浮窗"
          onClick={() => void window.earshot.hideGlance().catch(() => undefined)}
        >
          <CloseIcon />
        </button>
        <RecordingClock recording={recording} />
        <div className="grow" />
        <StopRecording recording={recording} />
      </header>
      <div className="glance-body" ref={bodyRef}>
        <Turns turns={turns} variant="glance" />
      </div>
      <footer className="glance-foot">
        {recording ? <RealtimeNotice recording={recording} compact /> : null}
        <button type="button" className="btn text" onClick={() => void window.earshot.showLibrary()}>
          查看完整文字
        </button>
      </footer>
    </div>
  );
}
