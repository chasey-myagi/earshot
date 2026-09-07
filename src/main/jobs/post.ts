import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptTurn } from "../../shared/types";
import { transcribeFile, toSessionTurns, type FileAsrTurn } from "../providers/file-asr.ts";
import type { SessionStore } from "../store/sessions.ts";
import { mergeTurns, readRefinedFile } from "../store/transcript.ts";
import { hasWavBody } from "../store/wav.ts";
import type { EmbedFn } from "../voiceprint/embed-run.ts";
import { identifySession } from "../voiceprint/identify.ts";
import { clustersFromTurns } from "../voiceprint/select.ts";
import { wavDurationMs } from "../voiceprint/wav.ts";
import { classifyJobFailure } from "./fail-reason.ts";

export type TranscribeFn = typeof transcribeFile;
export type IdentifyFn = typeof identifySession;

export async function processSession(opts: {
  apiKey: string;
  store: SessionStore;
  sessionId: string;
  mode: "all" | "refined" | "speakers";
  transcribe?: TranscribeFn;
  identify?: IdentifyFn;
  embed?: EmbedFn;
  onChange?: () => void;
  onFail?: (job: "refined" | "speakers", reason: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const transcribe = opts.transcribe ?? transcribeFile;
  const identify = opts.identify ?? identifySession;
  const doc = opts.store.readSession(opts.sessionId);
  if (!doc) throw new Error("找不到这场会");
  const dir = opts.store.sessionDir(opts.sessionId);
  const autoDiarize = doc.autoDiarize ?? opts.store.readPrefs().autoDiarize;
  const wantSpeakers = opts.mode === "speakers" || autoDiarize;
  const prevRefined = doc.jobs.refined;
  const checkCanceled = () => opts.signal?.throwIfAborted();

  opts.store.patchJobs(opts.sessionId, {
    refined: opts.mode === "speakers" ? undefined : { status: "running", reason: null },
    speakers: wantSpeakers ? { status: "running", reason: null } : undefined,
  });
  opts.onChange?.();

  try {
    checkCanceled();
    const micPath = join(dir, "mic.wav");
    const systemPath = join(dir, "system.wav");
    const canMic = hasWavBody(micPath);
    const canSystem = hasWavBody(systemPath);
    if (!canMic && !canSystem) throw new Error("没有可转写的音轨");

    let micTurns: TranscriptTurn[] = [];
    const refinedPath = doc.jobs.refined.current ? join(dir, doc.jobs.refined.current) : null;
    const reuseRefined = opts.mode === "speakers" && refinedPath && existsSync(refinedPath) ? refinedPath : null;
    if (reuseRefined) {
      micTurns = readRefinedFile(reuseRefined).filter((row) => row.track === "you");
    }
    if (!reuseRefined && canMic) {
      micTurns = toSessionTurns(
        await transcribe({ apiKey: opts.apiKey, filePath: micPath, diarize: false, signal: opts.signal }),
        "you",
        false,
      );
      checkCanceled();
    }

    let systemRows: FileAsrTurn[] = [];
    if (canSystem) {
      systemRows = await transcribe({
        apiKey: opts.apiKey,
        filePath: systemPath,
        diarize: wantSpeakers,
        signal: opts.signal,
      });
      checkCanceled();
    }
    const systemTurns = toSessionTurns(systemRows, "other", wantSpeakers);
    const turns = mergeTurns(micTurns, systemTurns);

    const refinedName = opts.store.nextArtifact(opts.sessionId, "refined");
    writeFileSync(join(dir, refinedName), `${JSON.stringify({ turns }, null, 2)}\n`);

    let speakersName: string | undefined;
    if (wantSpeakers) {
      speakersName = opts.store.nextArtifact(opts.sessionId, "speakers");
      const speakers = [...new Set(systemTurns.map((row) => row.speaker))];
      let durationMs = 0;
      try {
        durationMs = wavDurationMs(systemPath);
      } catch {
        durationMs = 0;
      }
      const clusters = clustersFromTurns(systemTurns, durationMs);
      writeFileSync(join(dir, speakersName), `${JSON.stringify({ speakers, clusters }, null, 2)}\n`);
      pruneStaleClusterNames(dir, speakers);
    }

    opts.store.patchJobs(opts.sessionId, {
      refined: { status: "done", current: refinedName, reason: null },
      speakers: wantSpeakers ? { status: "done", current: speakersName ?? null, reason: null } : undefined,
    });
  } catch (err) {
    const cancelled = Boolean(opts.signal?.aborted);
    const reason = cancelled ? "已取消" : classifyJobFailure(err);
    if (!cancelled) console.error("[earshot] post job failed", opts.sessionId, reason);
    if (!cancelled) {
      if (opts.mode === "speakers") opts.onFail?.("speakers", reason);
      else {
        opts.onFail?.("refined", reason);
        if (wantSpeakers) opts.onFail?.("speakers", reason);
      }
    }
    if (opts.mode === "speakers") {
      opts.store.patchJobs(opts.sessionId, {
        refined: { ...prevRefined },
        speakers: { status: cancelled ? "canceled" : "failed", reason: cancelled ? null : reason },
      });
    } else {
      opts.store.patchJobs(opts.sessionId, {
        refined: { status: cancelled ? "canceled" : "failed", reason: cancelled ? null : reason },
        speakers: wantSpeakers ? { status: cancelled ? "canceled" : "failed", reason: cancelled ? null : reason } : undefined,
      });
    }
  }

  const after = opts.store.readSession(opts.sessionId);
  if (!opts.signal?.aborted && after?.jobs.speakers.status === "done") {
    try {
      await identify({ store: opts.store, sessionId: opts.sessionId, embed: opts.embed });
    } catch {
      // voiceprint must not change refined/speakers job status
    }
  }
  opts.onChange?.();
}

function pruneStaleClusterNames(dir: string, speakers: string[]): void {
  const keep = new Set(speakers);
  for (const file of ["names.json", "auto-names.json"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const next: Record<string, string> = {};
    for (const [from, to] of Object.entries(raw as Record<string, unknown>)) {
      if (keep.has(from) && typeof to === "string" && to.trim()) next[from] = to;
    }
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  }
}
