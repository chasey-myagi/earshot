import { useEffect, useRef, useState } from "react";
import type { RecordingLive } from "../shared/types";
import { formatClock } from "./format";
import { useElapsed } from "./useElapsed";

export function StopRecording({ recording }: { recording: RecordingLive | null }) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentId = useRef(recording?.sessionId);
  currentId.current = recording?.sessionId;
  useEffect(() => { setError(null); }, [recording?.sessionId]);
  const stopping = busy || recording?.phase === "stopping";
  async function stop() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    const id = recording?.sessionId;
    try {
      const result = await window.earshot.stop();
      if (!result.ok && currentId.current === id) setError(result.error);
    } catch { if (currentId.current === id) setError("未能停止录音，请重试"); }
    finally { pending.current = false; setBusy(false); }
  }
  return <>
    <button type="button" className="btn stop" disabled={!recording || stopping || recording.phase === "starting"}
      onClick={() => void stop()}>{stopping ? "停止中…" : recording?.phase === "finalize_failed" ? "重试保存" : "停止录制"}</button>
    {error ? <span className="recording-error" role="alert">{error}</span> : null}
  </>;
}

export function RecordingClock({ recording }: { recording: RecordingLive | null }) {
  const elapsed = useElapsed(recording);
  if (!recording) return <span className="recording-clock">未在录制</span>;
  const label = recording.phase === "starting" ? "正在启动" : recording.phase === "stopping" ? "正在停止"
    : recording.phase === "finalize_failed" ? "保存未完成" : "录音中";
  return <span className="recording-clock"><i aria-hidden />{label} <time>{formatClock(elapsed)}</time></span>;
}

export function RealtimeNotice({ recording, compact = false }: { recording: RecordingLive; compact?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const connection = recording.connection ?? "connecting";
  const currentId = useRef(recording.sessionId);
  currentId.current = recording.sessionId;
  useEffect(() => { setError(null); }, [recording.sessionId, connection]);
  if (recording.phase === "finalize_failed") return <div className="realtime-notice disconnected" role="status">
    录音已停止，保存尚未完成。请重试保存。
  </div>;
  const disconnected = connection === "disconnected";
  const label = {
    connecting: "实时转写连接中",
    connected: "实时转写正常",
    disconnected: compact ? "转写已断开，录音继续" : "实时转写已断开，原始录音仍在保存",
    reconnecting: "重连中，录音继续",
  }[connection];
  return <div className={`realtime-notice${disconnected ? " disconnected" : ""}${compact ? " compact" : ""}`}>
    <span role="status">{label}</span>
    {recording.storageWarning ? <span role="status">{recording.storageWarning}</span> : null}
    {disconnected ? <button type="button" className="btn text"
      disabled={busy || (recording.phase !== undefined && recording.phase !== "recording")}
      title="重连后继续识别后续音频；缺失段在停录后处理"
      onClick={async () => {
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        setError(null);
        const id = recording.sessionId;
        try {
          const result = await window.earshot.retryRealtime();
          if (!result.ok && currentId.current === id) setError(result.error);
        } catch { if (currentId.current === id) setError("连接失败，请重试"); }
        finally { pending.current = false; setBusy(false); }
      }}>重新连接</button> : null}
    {error ? <span role="alert">{error}</span> : null}
  </div>;
}
