import { useEffect, useState } from "react";
import { DictationHUD } from "./Dictation";
import { Glance } from "./Glance";
import { Library } from "./Library";
import { useGlanceSnapshot, useSnapshot } from "./useSnapshot";
import { createMediaPlayback } from "./media-playback";
import { ActivitySignal } from "./ActivitySignal";

function useGlanceRoute(): boolean {
  const [glance, setGlance] = useState(() => location.hash === "#glance");
  useEffect(() => {
    const onHash = () => setGlance(location.hash === "#glance");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return glance;
}

function Boot({ label = "正在打开会话…", retry }: { label?: string; retry?: () => void }) {
  return (
    <div className="boot">
      {!retry && <ActivitySignal />}
      <span className="boot-message" role="status">{label}</span>
      {retry && <button type="button" className="btn ghost" onClick={retry}>重试</button>}
    </div>
  );
}

export function App() {
  const glance = useGlanceRoute();

  if (typeof window.earshot === "undefined") {
    return <Boot label="无法连接 Earshot，请退出后重新打开" />;
  }

  if (location.hash === "#dictation") return <DictationHUD />;
  if (glance) return <GlanceApp />;
  return <LibraryApp />;
}

function LibraryApp() {
  useEffect(() => {
    const host = createMediaPlayback({ createAudio: () => new Audio(), report: window.earshot.reportPlayback });
    const unsubscribe = window.earshot.onPlaybackCommand(command => { void host.command(command); });
    void window.earshot.playbackHost(true);
    return () => {
      unsubscribe(); host.dispose();
      void window.earshot.playbackHost(false);
    };
  }, []);
  const { snap, error, refresh } = useSnapshot();
  if (!snap) return <Boot label={error ?? undefined} retry={error ? () => void refresh() : undefined} />;
  return <Library snap={snap} refresh={refresh} syncError={error} />;
}

function GlanceApp() {
  const recording = useGlanceSnapshot();
  return <Glance recording={recording} />;
}
