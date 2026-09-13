import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSnapshot, RecordingLive } from "../shared/types";
import { glanceRecordingEqual, shareSnapshotTurns } from "./snapshotPick";

function hydrate(raw: AppSnapshot): AppSnapshot {
  return {
    ...raw,
    hasApiKey: raw.hasApiKey,
    autoDiarize: raw.autoDiarize ?? true,
    permissions: raw.permissions ?? { microphone: "undetermined", screen: "undetermined" },
    recording: raw.recording ?? null,
    playingSessionId: raw.playingSessionId ?? null,
    playback: raw.playback ?? null,
    capturePhase: raw.capturePhase ?? (raw.recording ? "recording" : "idle"),
    sessions: raw.sessions ?? [],
    selectedId: raw.selectedId ?? null,
    selected: raw.selected ?? null,
    libraryRequest: raw.libraryRequest ?? 0,
  };
}

export function useSnapshot() {
  const [state, setState] = useState<{ snap: AppSnapshot | null; error: string | null }>({ snap: null, error: null });
  const pendingRef = useRef(false);
  const request = useRef(0), active = useRef(false);

  const refresh = useCallback(async () => {
    if (typeof window.earshot === "undefined") return;
    const ticket = ++request.current;
    try {
      const next = hydrate(await window.earshot.snapshot());
      if (active.current && ticket === request.current) setState(previous => ({ snap: shareSnapshotTurns(previous.snap, next), error: null }));
    } catch {
      if (active.current && ticket === request.current) setState(previous => ({ ...previous, error: '无法更新会话，请重试' }));
    }
  }, []);

  useEffect(() => {
    if (typeof window.earshot === "undefined") return;
    active.current = true;
    void refresh();

    const schedule = () => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      requestAnimationFrame(() => {
        pendingRef.current = false;
        void refresh();
      });
    };

    const off = window.earshot.onChange(schedule);
    window.addEventListener('focus', schedule);
    return () => { active.current = false; request.current++; off(); window.removeEventListener('focus', schedule); };
  }, [refresh]);

  return { ...state, refresh };
}

/** Glance 窗口：合并广播 + 只在 recording 实质变化时更新 */
export function useGlanceSnapshot(): RecordingLive | null {
  const [recording, setRecording] = useState<RecordingLive | null>(null);
  const pendingRef = useRef(false);
  const stableRef = useRef<RecordingLive | null>(null);

  const apply = useCallback((next: RecordingLive | null) => {
    if (glanceRecordingEqual(stableRef.current, next)) return;
    stableRef.current = next;
    setRecording(next);
  }, []);

  const refresh = useCallback(async () => {
    if (typeof window.earshot === "undefined") return;
    const raw = hydrate(await window.earshot.snapshot());
    apply(raw.recording);
  }, [apply]);

  useEffect(() => {
    if (typeof window.earshot === "undefined") return;
    void refresh();

    const schedule = () => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      requestAnimationFrame(() => {
        pendingRef.current = false;
        void refresh();
      });
    };

    return window.earshot.onChange(schedule);
  }, [refresh]);

  return recording;
}
