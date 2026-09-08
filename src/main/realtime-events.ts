import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RealtimeFailureCategory, Track } from "../shared/types";

export type RealtimeEvent = {
  track: Track; at: number; event: "connecting" | "connected" | "failed" | "retry-scheduled" | "retry-exhausted" | "stopped";
  attempt: number; taskId: string; category?: RealtimeFailureCategory; providerCode?: string; retryDelayMs?: number;
};

/** One recording owns a bounded diagnostic journal. Never accept provider payloads or text. */
export function createRealtimeEventWriter(dir: string): (event: RealtimeEvent) => void {
  const path = join(dir, "realtime-events.json");
  const events: RealtimeEvent[] = [];
  return input => {
    const event: RealtimeEvent = { track: input.track, at: input.at, event: input.event, attempt: input.attempt, taskId: input.taskId,
      ...(input.category ? { category: input.category } : {}), ...(input.providerCode ? { providerCode: input.providerCode } : {}),
      ...(input.retryDelayMs !== undefined ? { retryDelayMs: input.retryDelayMs } : {}) };
    events.push(event); if (events.length > 200) events.shift();
    try {
      if (existsSync(path)) chmodSync(path, 0o600);
      writeFileSync(path, JSON.stringify({ version: 1, events }) + "\n", { mode: 0o600 });
    } catch { /* Recording and recovery must not depend on diagnostic storage. */ }
  };
}
