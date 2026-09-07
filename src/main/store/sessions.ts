import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionResult, JobStatus, RenameSpeakerInput, SessionDetail, SessionJobs, SessionSummary } from "../../shared/types";
import type { Prefs, SessionDocument } from "./schema";
import { sessionTranscript } from "./transcript.ts";
import { repairSessionWavs, sessionDurationSec, sessionHasWavBody } from "./wav.ts";

const DEFAULT_PREFS: Prefs = { autoDiarize: true };

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  // A failed or partial write must leave the last committed document readable.
  // Keep honoring an explicitly read-only existing file when replacing it.
  if (existsSync(path)) accessSync(path, constants.W_OK);
  const pending = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(pending, path);
  } finally {
    try { rmSync(pending, { force: true }); } catch { /* preserve the original IO error */ }
  }
}

function asDocument(raw: unknown): SessionDocument | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<SessionDocument>;
  if (typeof row.id !== "string" || typeof row.startedAt !== "string") return null;
  const refined = row.jobs?.refined;
  const speakers = row.jobs?.speakers;
  return {
    schema_version: 1,
    ...(row.kind === "dictation" && row.dictation && typeof row.dictation.text === "string" && typeof row.dictation.rawText === "string" ? { kind: "dictation" as const, dictation: row.dictation } : {}),
    id: row.id,
    title: typeof row.title === "string" ? row.title : "新的会话",
    startedAt: row.startedAt,
    endedAt: typeof row.endedAt === "string" ? row.endedAt : null,
    durationSec: typeof row.durationSec === "number" ? row.durationSec : 0,
    status: row.status === "complete" || row.status === "incomplete" || row.status === "recording" ? row.status : "incomplete",
    ...(typeof row.autoDiarize === "boolean" ? { autoDiarize: row.autoDiarize } : {}),
    audio: { sampleRate: 16000, channels: 1, codec: "pcm_s16le" },
    tracks: { microphone: true, system: true },
    jobs: {
      live: row.jobs?.live === "running" || row.jobs?.live === "done" || row.jobs?.live === "failed" ? row.jobs.live : "idle",
      refined: {
        status: refined && "status" in refined && refined.status ? refined.status : "idle",
        current: refined && "current" in refined ? refined.current : null,
        ...(typeof refined?.reason === "string" ? { reason: refined.reason } : {}),
      },
      speakers: {
        status: speakers && "status" in speakers && speakers.status ? speakers.status : "idle",
        current: speakers && "current" in speakers ? speakers.current : null,
        ...(typeof speakers?.reason === "string" ? { reason: speakers.reason } : {}),
      },
    },
  };
}

function toJobs(doc: SessionDocument): SessionJobs {
  return {
    live: doc.jobs.live,
    refined: doc.jobs.refined.status,
    speakers: doc.jobs.speakers.status,
    ...(doc.jobs.refined.status === "failed" && doc.jobs.refined.reason ? { failedReason: doc.jobs.refined.reason } : {}),
    ...(doc.jobs.speakers.status === "failed" && doc.jobs.speakers.reason ? { speakersFailReason: doc.jobs.speakers.reason } : {}),
  };
}

function toSummary(doc: SessionDocument): SessionSummary {
  return {
    ...(doc.kind === "dictation" ? { kind: "dictation" as const } : {}),
    id: doc.id,
    title: doc.title,
    startedAt: doc.startedAt,
    durationSec: doc.durationSec,
    status: doc.status,
    jobs: toJobs(doc),
  };
}

/** Legacy names remain readable, but an ID is always one bounded directory component. */
export function isSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

export function createSessionStore(rootDir: string) {
  const sessionsRoot = join(rootDir, "sessions");
  let listed: SessionDocument[] | null = null;
  const details = new Map<string, { detail: SessionDetail; live: string }>();

  function liveKey(id: string): string {
    try {
      const st = statSync(join(sessionDir(id), "live.jsonl"));
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return "";
    }
  }

  function forgetListed(): void {
    listed = null;
  }

  function forgetDetails(id?: string): void {
    if (id) details.delete(id);
    else details.clear();
  }

  function ensure(): void {
    mkdirSync(sessionsRoot, { recursive: true });
  }

  function prefsPath(): string {
    return join(rootDir, "prefs.json");
  }

  function peoplePath(): string {
    return join(rootDir, "people.json");
  }

  function sessionDir(id: string): string {
    if (!isSessionId(id)) throw new Error("无效的会话标识");
    return join(sessionsRoot, id);
  }

  function sessionFile(id: string): string {
    return join(sessionDir(id), "session.json");
  }

  function namesFile(id: string): string {
    return join(sessionDir(id), "names.json");
  }

  function readPrefs(): Prefs {
    if (!existsSync(prefsPath())) return { ...DEFAULT_PREFS };
    try {
      const raw = readJson(prefsPath()) as Partial<Prefs>;
      return { autoDiarize: raw.autoDiarize !== false };
    } catch {
      return { ...DEFAULT_PREFS };
    }
  }

  function setAutoDiarize(on: boolean): void {
    ensure();
    writeJson(prefsPath(), { autoDiarize: on });
  }

  function readPeople(): string[] {
    if (!existsSync(peoplePath())) return [];
    try {
      const raw = readJson(peoplePath());
      if (!Array.isArray(raw)) return [];
      return raw.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
    } catch {
      return [];
    }
  }

  function writePeople(names: string[]): void {
    ensure();
    writeJson(peoplePath(), names);
    forgetDetails();
  }

  function readNames(id: string): Record<string, string> {
    const path = namesFile(id);
    if (!existsSync(path)) return {};
    try {
      const raw = readJson(path);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const out: Record<string, string> = {};
      for (const [from, to] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof to === "string" && to.trim()) out[from] = to;
      }
      return out;
    } catch {
      return {};
    }
  }

  function writeSession(doc: SessionDocument): void {
    mkdirSync(sessionDir(doc.id), { recursive: true });
    writeJson(sessionFile(doc.id), doc);
    forgetListed();
    forgetDetails(doc.id);
  }

  function readSession(id: string): SessionDocument | null {
    if (!isSessionId(id)) return null;
    const path = sessionFile(id);
    if (!existsSync(path)) return null;
    try {
      return asDocument(readJson(path));
    } catch {
      return null;
    }
  }

  function listDocuments(): SessionDocument[] {
    if (listed) return listed;
    ensure();
    const rows: SessionDocument[] = [];
    for (const id of readdirSync(sessionsRoot)) {
      if (!isSessionId(id)) continue;
      const path = sessionFile(id);
      if (!existsSync(path)) continue;
      try {
        const doc = asDocument(readJson(path));
        if (doc) rows.push(doc);
      } catch {
        // skip corrupt session folders; they remain on disk
      }
    }
    listed = rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return listed;
  }

  function listSummaries(): SessionSummary[] {
    return listDocuments().map(toSummary);
  }

  function getDetail(id: string): SessionDetail | null {
    const live = liveKey(id);
    const cached = details.get(id);
    if (cached && cached.live === live) return cached.detail;
    const doc = readSession(id);
    if (!doc) return null;
    const names = readNames(id);
    const people = [...new Set([...readPeople(), ...Object.values(names)])];
    const detail: SessionDetail = {
      ...toSummary(doc),
      endedAt: doc.endedAt,
      turns: doc.kind === "dictation" && doc.dictation ? [{ id: "dictation", track: "you", speaker: "你", tStartMs: 0, text: doc.dictation.text }] : sessionTranscript(sessionDir(id), doc.jobs.refined.current, names),
      ...(doc.dictation ? { dictation: doc.dictation } : {}),
      people: doc.kind === "dictation" ? [] : people,
    };
    details.set(id, { detail, live });
    return detail;
  }

  function createRecording(): SessionDocument {
    ensure();
    const started = new Date();
    const clock = `${String(started.getHours()).padStart(2, "0")}:${String(started.getMinutes()).padStart(2, "0")}`;
    const doc: SessionDocument = {
      schema_version: 1,
      id: randomUUID(),
      title: `${started.getMonth() + 1}月${started.getDate()}日 ${clock} 的录音`,
      startedAt: started.toISOString(),
      endedAt: null,
      durationSec: 0,
      status: "recording",
      autoDiarize: readPrefs().autoDiarize,
      audio: { sampleRate: 16000, channels: 1, codec: "pcm_s16le" },
      tracks: { microphone: true, system: true },
      jobs: {
        live: "running",
        refined: { status: "idle", current: null },
        speakers: { status: "idle", current: null },
      },
    };
    writeSession(doc);
    return doc;
  }

  function saveDictation(input: { id: string; startedAt: number; durationSec: number; result: import("../../shared/types").DictationDocument }): void {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.id) || !input.result.text.trim()) throw new Error("无效的语音输入记录");
    const existing = readSession(input.id);
    if (existing && existing.kind !== 'dictation') throw new Error("会话类型不匹配");
    const doc: SessionDocument = { schema_version: 1, id: input.id, kind: 'dictation', dictation: { ...input.result },
      title: existing?.title ?? Array.from(input.result.text.replace(/\s+/g, ' ').trim()).slice(0, 24).join(''),
      startedAt: new Date(input.startedAt).toISOString(), endedAt: new Date().toISOString(), durationSec: input.durationSec, status: 'complete',
      audio: { sampleRate: 16000, channels: 1, codec: 'pcm_s16le' }, tracks: { microphone: false, system: false },
      jobs: { live: 'done', refined: { status: 'idle', current: null }, speakers: { status: 'idle', current: null } } };
    writeSession(doc);
  }

  function renameSession(raw: unknown): ActionResult {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "无效的会话名称" };
    const { sessionId, title: input } = raw as { sessionId?: unknown; title?: unknown };
    if (typeof sessionId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
      return { ok: false, error: "找不到这场会" };
    }
    if (typeof input !== "string") return { ok: false, error: "无效的会话名称" };
    const title = input.trim();
    if (!title) return { ok: false, error: "名称不能为空" };
    if (Array.from(title).length > 80) return { ok: false, error: "名称最多 80 个字符" };
    if (/[\u0000-\u001f\u007f]/.test(title)) return { ok: false, error: "名称不能包含换行或控制字符" };
    const doc = readSession(sessionId);
    if (!doc) return { ok: false, error: "找不到这场会" };
    try {
      writeSession({ ...doc, title });
      return { ok: true };
    } catch { return { ok: false, error: "名称没能保存，请重试" }; }
  }

  function finalize(
    id: string,
    status: "complete" | "incomplete",
    extra?: { durationSec?: number; endedAt?: string; live?: JobStatus },
  ): SessionDocument | null {
    const doc = readSession(id);
    if (!doc) return null;
    doc.status = status;
    doc.endedAt = extra?.endedAt ?? new Date().toISOString();
    if (typeof extra?.durationSec === "number") doc.durationSec = extra.durationSec;
    if (extra && "live" in extra && extra.live) doc.jobs.live = extra.live;
    else if (doc.jobs.live === "running") doc.jobs.live = "done";
    writeSession(doc);
    return doc;
  }

  function patchJobs(
    id: string,
    patch: {
      live?: JobStatus;
      refined?: { status?: JobStatus; current?: string | null; reason?: string | null };
      speakers?: { status?: JobStatus; current?: string | null; reason?: string | null };
    },
  ): SessionDocument | null {
    const doc = readSession(id);
    if (!doc) return null;
    if (patch.live) doc.jobs.live = patch.live;
    if (patch.refined) {
      if (patch.refined.status) doc.jobs.refined.status = patch.refined.status;
      if ("current" in patch.refined) doc.jobs.refined.current = patch.refined.current ?? null;
      if ("reason" in patch.refined) {
        if (patch.refined.reason) doc.jobs.refined.reason = patch.refined.reason;
        else delete doc.jobs.refined.reason;
      }
    }
    if (patch.speakers) {
      if (patch.speakers.status) doc.jobs.speakers.status = patch.speakers.status;
      if ("current" in patch.speakers) doc.jobs.speakers.current = patch.speakers.current ?? null;
      if ("reason" in patch.speakers) {
        if (patch.speakers.reason) doc.jobs.speakers.reason = patch.speakers.reason;
        else delete doc.jobs.speakers.reason;
      }
    }
    writeSession(doc);
    return doc;
  }

  function nextArtifact(id: string, prefix: "refined" | "speakers"): string {
    let n = 1;
    while (existsSync(join(sessionDir(id), `${prefix}-v${n}.json`))) n += 1;
    return `${prefix}-v${n}.json`;
  }

  function recoverOrphans(): string[] {
    const ids: string[] = [];
    for (const doc of listDocuments()) {
      if (doc.status !== "recording") continue;
      const dir = sessionDir(doc.id);
      repairSessionWavs(dir);
      finalize(doc.id, "incomplete", { durationSec: sessionDurationSec(dir, 0) });
      ids.push(doc.id);
    }
    return ids;
  }

  function discardEmptyRecording(id: string): boolean {
    const dir = sessionDir(id);
    if (sessionHasWavBody(dir)) return false;
    rmSync(dir, { recursive: true, force: true });
    forgetListed();
    forgetDetails(id);
    return true;
  }

  function renameSpeaker(input: RenameSpeakerInput): ActionResult {
    const from = input.from.trim();
    const to = input.to.trim();
    if (!from || !to) return { ok: false, error: "名字不能为空" };
    const doc = readSession(input.sessionId);
    if (!doc) return { ok: false, error: "找不到这场会" };
    const names = readNames(input.sessionId);
    for (const [key, value] of Object.entries(names)) {
      if (value === from) names[key] = to;
    }
    names[from] = to;
    writeJson(namesFile(input.sessionId), names);
    const people = readPeople();
    if (!people.includes(to)) people.push(to);
    writePeople(people);
    return { ok: true };
  }

  function writeNames(id: string, names: Record<string, string>): void {
    if (!readSession(id)) throw new Error("Session not found");
    writeJson(namesFile(id), names);
    forgetDetails(id);
  }

  function rememberPerson(name: string): void {
    const people = readPeople();
    if (!people.includes(name)) writePeople([...people, name]);
  }

  return {
    rootDir,
    sessionDir,
    readPrefs,
    setAutoDiarize,
    readPeople,
    readSession,
    writeSession,
    listSummaries,
    getDetail,
    readNames,
    writeNames,
    rememberPerson,
    createRecording,
    saveDictation,
    renameSession,
    finalize,
    patchJobs,
    nextArtifact,
    recoverOrphans,
    discardEmptyRecording,
    renameSpeaker,
    invalidate: (id: string) => { forgetListed(); forgetDetails(id); },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
