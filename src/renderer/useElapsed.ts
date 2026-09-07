import { useEffect, useMemo, useState } from "react";
import type { RecordingLive } from "../shared/types";

export function useElapsed(live: RecordingLive | null): number {
  const [now, setNow] = useState(() => Date.now());
  const mark = useMemo(() => ({ sec: live?.elapsedSec ?? 0, at: Date.now() }),
    [live?.elapsedSec, live?.sessionId, live?.phase]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!live) return 0;
  if (live.phase && live.phase !== "recording") return live.elapsedSec;
  return mark.sec + Math.max(0, Math.floor((now - mark.at) / 1000));
}
