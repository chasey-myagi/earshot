import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptTurn } from "../../shared/types";
import { transcribeFile, toSessionTurns, type FileAsrTurn } from "../providers/file-asr.ts";
import type { SessionStore } from "../store/sessions.ts";
import { mergeTurns, readRefinedFile, sessionTranscript } from "../store/transcript.ts";
import { hasWavBody } from "../store/wav.ts";
import type { EmbedFn } from "../voiceprint/embed-run.ts";
import { identifySession } from "../voiceprint/identify.ts";
import { clustersFromTurns } from "../voiceprint/select.ts";
import { wavDurationMs } from "../voiceprint/wav.ts";
import { classifyJobFailure } from "./fail-reason.ts";
import { audioKey } from "../providers/asr-checkpoint.ts";

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
  retryUncertainSubmission?: boolean;
}): Promise<void> {
  const transcribe = opts.transcribe ?? transcribeFile;
  const identify = opts.identify ?? identifySession;
  const doc = opts.store.readSession(opts.sessionId);
  if (!doc) throw new Error("找不到这场会");
  const dir = opts.store.sessionDir(opts.sessionId);
  const autoDiarize = doc.autoDiarize ?? opts.store.readPrefs().autoDiarize;
  const wantSpeakers = opts.mode === "speakers" || autoDiarize;
  const sharedMicrophone = doc.sharedMicrophone === true;
  const prevRefined = doc.jobs.refined;
  const checkCanceled = () => opts.signal?.throwIfAborted();
  let systemSucceeded = false;
  let published = false;

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
    let micError: unknown;
    let systemError: unknown;
    const sourceKeys: { you?: string; other?: string } = {};
    const fallback = sessionTranscript(dir, doc.jobs.refined.current, {});
    const refinedPath = doc.jobs.refined.current ? join(dir, doc.jobs.refined.current) : null;
    const reuseRefined = !sharedMicrophone && opts.mode === "speakers" && refinedPath && existsSync(refinedPath) ? refinedPath : null;
    if (reuseRefined) {
      micTurns = readRefinedFile(reuseRefined).filter((row) => row.track === "you");
    }
    if (!reuseRefined && canMic) {
      try {
        sourceKeys.you = await audioKey(micPath, sharedMicrophone && wantSpeakers, opts.signal);
        micTurns = toSessionTurns(
          await transcribe({ apiKey: opts.apiKey, filePath: micPath, diarize: sharedMicrophone && wantSpeakers, signal: opts.signal,
            checkpointPath: join(dir, sharedMicrophone && wantSpeakers ? "asr-mic-speakers.json" : "asr-mic.json"),
            inputKey: sourceKeys.you, retryUncertainSubmission: opts.retryUncertainSubmission }),
          "you",
          sharedMicrophone && wantSpeakers,
          sharedMicrophone,
        );
        checkCanceled();
      } catch (err) { checkCanceled(); micError = err; micTurns = fallback.filter(row => row.track === "you"); }
    }

    let systemRows: FileAsrTurn[] = [];
    if (canSystem) {
      try {
        sourceKeys.other = await audioKey(systemPath, wantSpeakers, opts.signal);
        systemRows = await transcribe({
          apiKey: opts.apiKey,
          filePath: systemPath,
          diarize: wantSpeakers,
          signal: opts.signal,
          checkpointPath: join(dir, wantSpeakers ? "asr-system-speakers.json" : "asr-system.json"),
          inputKey: sourceKeys.other,
          retryUncertainSubmission: opts.retryUncertainSubmission,
        });
        checkCanceled();
        systemSucceeded = true;
      } catch (err) { checkCanceled(); systemError = err; }
    } else {
      systemSucceeded = true;
    }
    const systemTurns = systemError ? fallback.filter(row => row.track === "other") : toSessionTurns(systemRows, "other", wantSpeakers);
    const missingSpeakers = wantSpeakers && ((!systemError && systemTurns.some(row => row.speaker === "对方"))
      || (sharedMicrophone && !micError && micTurns.some(row => row.speaker === "现场")));
    if (sharedMicrophone && micError) systemSucceeded = false;
    const turns = mergeTurns(micTurns, systemTurns);
    if ((micError || systemError) && !turns.length) throw micError ?? systemError;
    if (opts.mode === "speakers" && systemError && (reuseRefined || !canMic || micError)) throw systemError;

    const refinedName = opts.store.nextArtifact(opts.sessionId, "refined");
    const previousNames = opts.store.readNames(opts.sessionId);
    let previousKeys: typeof sourceKeys | undefined;
    try { previousKeys = refinedPath ? JSON.parse(readFileSync(refinedPath, "utf8")).sourceKeys : undefined; } catch { /* legacy or absent draft */ }
    const sameSource = previousKeys && previousKeys.other === sourceKeys.other && (!sharedMicrophone || previousKeys.you === sourceKeys.you);
    const sameSystem = sameSource && JSON.stringify(fallback.filter(row => row.speaker !== "你")) === JSON.stringify(turns.filter(row => row.speaker !== "你"));
    // Bind legacy maps before advancing the transcript, so interruption cannot
    // attach their labels to a new grouping. Keep corrections as historical evidence.
    writeFileSync(join(dir, `${refinedName}.previous-names.json`), JSON.stringify({ artifact: doc.jobs.refined.current, names: previousNames }), { mode: 0o600 });
    opts.store.writeNames(opts.sessionId, previousNames);
    writeFileSync(join(dir, refinedName), `${JSON.stringify({ turns, sourceKeys }, null, 2)}\n`, { mode: 0o600 });

    let speakersName: string | undefined;
    if (wantSpeakers && systemSucceeded && !missingSpeakers) {
      speakersName = opts.store.nextArtifact(opts.sessionId, "speakers");
      const speakers = [...new Set(turns.filter(row => row.speaker !== "你").map(row => row.speaker))];
      let durationMs = 0;
      try {
        durationMs = wavDurationMs(systemPath);
      } catch {
        durationMs = 0;
      }
      const clusters = clustersFromTurns(systemTurns, durationMs);
      if (sharedMicrophone && canMic) clusters.push(...clustersFromTurns(micTurns, wavDurationMs(micPath), "you"));
      writeFileSync(join(dir, speakersName), `${JSON.stringify({ speakers, clusters }, null, 2)}\n`);
    }

    opts.store.patchJobs(opts.sessionId, {
      refined: { status: "done", current: refinedName, reason: null },
      speakers: missingSpeakers ? { status: "failed", current: null, reason: "文字已保存，服务未返回完整说话人分组" }
        : wantSpeakers ? (systemSucceeded ? { status: "done", current: speakersName ?? null, reason: null } : { status: "failed", current: null, reason: null }) : undefined,
    });
    opts.store.writeNames(opts.sessionId, sameSystem ? previousNames : {});
    if (!sameSystem) writeFileSync(join(dir, "auto-names.json"), "{}\n", { mode: 0o600 });
    if (missingSpeakers) opts.onFail?.("speakers", "文字已保存，服务未返回完整说话人分组");
    published = true;
    if (micError || systemError) throw micError ?? systemError;
  } catch (err) {
    const cancelled = Boolean(opts.signal?.aborted);
    const reason = cancelled ? "已取消" : classifyJobFailure(err);
    if (!cancelled) console.error("[earshot] post job failed", opts.sessionId, reason);
    if (!cancelled) {
      if (opts.mode === "speakers") opts.onFail?.("speakers", reason);
      else {
        opts.onFail?.("refined", reason);
        if (wantSpeakers && !(systemSucceeded && published)) opts.onFail?.("speakers", reason);
      }
    }
    if (opts.mode === "speakers") {
      opts.store.patchJobs(opts.sessionId, {
        refined: published ? { status: cancelled ? "canceled" : "failed", reason: cancelled ? null : reason } : { ...prevRefined },
        speakers: { status: cancelled ? "canceled" : "failed", reason: cancelled ? null : reason },
      });
    } else {
      opts.store.patchJobs(opts.sessionId, {
        refined: { status: cancelled ? "canceled" : "failed", reason: cancelled ? null : reason },
        speakers: wantSpeakers && !(systemSucceeded && published) ? { status: cancelled ? "canceled" : "failed", reason: cancelled ? null : reason } : undefined,
      });
    }
  }

  const after = opts.store.readSession(opts.sessionId);
  if (!opts.signal?.aborted && after?.jobs.speakers.status === "done") {
    try {
      await identify({ store: opts.store, sessionId: opts.sessionId, embed: opts.embed, signal: opts.signal });
    } catch {
      // voiceprint must not change refined/speakers job status
    }
  }
  opts.onChange?.();
}
