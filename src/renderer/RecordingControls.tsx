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
    reconnecting: compact ? "转写重连中，录音继续" : "实时转写正在自动重连，原始录音仍在保存",
  }[connection];
  const reason = { transport: "网络连接中断", "ready-timeout": "连接超时", "provider-timeout": "转写服务超时",
    server: "转写服务暂时不可用", "rate-limit": "转写服务请求过于频繁", auth: "密钥无效或没有访问权限",
    quota: "账户余额或额度不足", "invalid-request": "转写设置不受支持", provider: "转写服务拒绝请求", "task-finished": "转写任务意外结束" };
  const explanation = connection === "connected" ? "" : Object.entries(recording.connectionDetail?.tracks ?? {}).map(([track, info]) => {
    const name = track === "you" ? "麦克风" : "系统声音";
    if (info.status === "connected") return `${name}：已连接`;
    if (info.status === "connecting") return `${name}：连接中`;
    const cause = info.category ? reason[info.category] : "连接中断";
    if (info.status === "reconnecting") {
      const interval = info.retryDelayMs !== undefined && info.retryDelayMs > 0 ? `，重试间隔 ${info.retryDelayMs / 1000} 秒` : "";
      return `${name}：${cause}，正在自动重试${interval}`;
    }
    return `${name}：${cause}${info.attempt >= 5 ? "，自动重连已达上限" : ""}`;
  }).join("；");
  return <div className={`realtime-notice${disconnected ? " disconnected" : ""}${compact ? " compact" : ""}`}>
    <span role="status">{label}</span>
    {explanation ? <span role="status">{explanation}</span> : null}
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
