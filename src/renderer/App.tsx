import { useEffect, useState } from "react";
import { DictationHUD } from "./Dictation";
import { Glance } from "./Glance";
import { Library } from "./Library";
import { useGlanceSnapshot, useSnapshot } from "./useSnapshot";
import { createMediaPlayback } from "./media-playback";

function useGlanceRoute(): boolean {
  const [glance, setGlance] = useState(() => location.hash === "#glance");
  useEffect(() => {
    const onHash = () => setGlance(location.hash === "#glance");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return glance;
}

function Boot({ label }: { label?: string }) {
  return (
    <div className="boot">
      <span className="boot-dot" aria-hidden />
      {label ? <span>{label}</span> : null}
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
  const { snap, refresh } = useSnapshot();
  if (!snap) return <Boot />;
  return <Library snap={snap} refresh={refresh} />;
}

function GlanceApp() {
  const recording = useGlanceSnapshot();
  return <Glance recording={recording} />;
}
