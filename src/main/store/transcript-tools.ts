import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionResult, SessionDetail, TranscriptTurn } from "../../shared/types";
import type { Bookmark, TranscriptSearchResult, TurnCorrectionMeta } from "../../shared/transcript-tools";
import { writeJson } from "./json.ts";

type Value = { text?: string; speaker?: string };
type Edit = { version: number; value: Value; history: Value[]; source: { artifact: string; turn: TranscriptTurn } };
type Edits = { schema_version: 1; records: Record<string, Edit> };
type Source = { sessionId: string; dir: string; artifact: string; turns: TranscriptTurn[]; names: Record<string, string> };
export type EditableTurn = TranscriptTurn & { correction?: TurnCorrectionMeta };
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, max: number, multiline = false): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !control.test(value) && (multiline || !/[\r\n\t]/.test(value));
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function sourceKey(source: Source, turn: TranscriptTurn): string {
  return hash([source.sessionId, source.artifact, turn.id, turn.track, turn.speaker, turn.tStartMs, turn.tEndMs, turn.text]);
}
function validValue(value: unknown): value is Value {
  return object(value) && Object.keys(value).every(key => key === "text" || key === "speaker") &&
    (value.text === undefined || text(value.text, 20_000, true)) && (value.speaker === undefined || text(value.speaker, 80));
}
function readEdits(dir: string): Edits {
  const path = join(dir, "corrections.json");
  if (!existsSync(path)) return { schema_version: 1, records: {} };
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!object(raw) || raw.schema_version !== 1 || !object(raw.records) || Object.keys(raw.records).length > 100_000) throw new Error("损坏的纠错记录");
  for (const [key, edit] of Object.entries(raw.records)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !object(edit) || !Number.isSafeInteger(edit.version) || (edit.version as number) < 0 || !validValue(edit.value) ||
        !Array.isArray(edit.history) || edit.history.length > 20 || !edit.history.every(validValue) || !object(edit.source) || typeof edit.source.artifact !== "string" ||
        !object(edit.source.turn) || typeof edit.source.turn.id !== "string" || typeof edit.source.turn.text !== "string" || typeof edit.source.turn.speaker !== "string" ||
        typeof edit.source.turn.tStartMs !== "number") throw new Error("损坏的纠错记录");
  }
  return raw as unknown as Edits;
}
function baseSpeaker(source: Source, turn: TranscriptTurn): string { return source.names[turn.speaker] || turn.speaker; }
function revision(source: Source, turn: TranscriptTurn, edit?: Edit): string { return hash([sourceKey(source, turn), edit?.version ?? 0, baseSpeaker(source, turn)]); }
function overlay(source: Source, edits: Edits): EditableTurn[] {
  const ids = new Map<string, number>();
  source.turns.forEach(turn => ids.set(turn.id, (ids.get(turn.id) ?? 0) + 1));
  return source.turns.map(turn => {
    const originalSpeaker = baseSpeaker(source, turn);
    const edit = edits.records[sourceKey(source, turn)];
    const value = edit?.value ?? {};
    return { ...turn, text: value.text ?? turn.text, speaker: value.speaker ?? originalSpeaker,
      ...(!turn.partial && ids.get(turn.id) === 1 ? { correction: {
        revision: revision(source, turn, edit), originalText: turn.text, originalSpeaker: turn.speaker,
        edited: Object.keys(value).length > 0, speakerOverridden: value.speaker !== undefined, canUndo: !!edit?.history.length,
      } } : {}) };
  });
}
export function readCorrectedTurns(source: Source): { turns: EditableTurn[]; error?: string } {
  try {
    const edits = readEdits(source.dir);
    const current = new Set(source.turns.map(turn => sourceKey(source, turn)));
    const stale = Object.entries(edits.records).filter(([key, edit]) => !current.has(key) && Object.keys(edit.value).length > 0).length;
    return { turns: overlay(source, edits), ...(stale ? { error: `${stale} 段旧稿修改未套用于新稿；原修改记录已保留。` } : {}) };
  }
  catch { return { turns: source.turns.map(turn => ({ ...turn, speaker: baseSpeaker(source, turn) })), error: "纠错记录无法读取，原始转写仍保留；为避免覆盖记录，暂时不能编辑。" }; }
}
export function changeTurn(source: Source, raw: unknown, action: "correct" | "undo" | "reset"): ActionResult {
  if (!object(raw) || raw.sessionId !== source.sessionId || !text(raw.turnId, 256) || typeof raw.revision !== "string" || !/^[a-f0-9]{64}$/.test(raw.revision)) return { ok: false, error: "无效的段落，请刷新后重试" };
  const matching = source.turns.filter(turn => turn.id === raw.turnId);
  if (matching.length !== 1 || matching[0].partial) return { ok: false, error: "这段转写已变化，请重新打开编辑" };
  const turn = matching[0];
  if (action === "correct" && (!text(raw.text, 20_000, true) || !text(raw.speaker, 80))) return { ok: false, error: "正文不能为空且最多 20000 字；说话人最多 80 字" };
  try {
    const edits = readEdits(source.dir);
    const key = sourceKey(source, turn);
    const previous = edits.records[key];
    if (raw.revision !== revision(source, turn, previous)) return { ok: false, error: "这段转写已更新，请重新打开编辑" };
    let value: Value;
    let history = previous?.history ?? [];
    if (action === "undo") {
      if (!history.length) return { ok: false, error: "没有可撤销的修改" };
      value = history[history.length - 1];
      history = history.slice(0, -1);
    } else {
      value = action === "reset" ? {} : {
        ...(raw.text !== turn.text ? { text: raw.text as string } : {}),
        // Keeping an existing manual name must not silently turn it into a cluster name.
        ...(raw.speaker !== baseSpeaker(source, turn) || previous?.value.speaker === raw.speaker ? { speaker: (raw.speaker as string).trim() } : {}),
      };
      if (JSON.stringify(value) === JSON.stringify(previous?.value ?? {})) return { ok: true };
      history = [...history, previous?.value ?? {}].slice(-20);
    }
    edits.records[key] = { version: (previous?.version ?? 0) + 1, value, history, source: { artifact: source.artifact, turn: { ...turn } } };
    writeJson(join(source.dir, "corrections.json"), edits);
    return { ok: true };
  } catch { return { ok: false, error: "纠错记录没能保存；已有记录保持不变，请检查文件后重试" }; }
}

export function readBookmarks(dir: string): Bookmark[] {
  const path = join(dir, "bookmarks.json");
  if (!existsSync(path)) return [];
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!object(raw) || raw.schema_version !== 1 || !Array.isArray(raw.items) || raw.items.length > 10_000) throw new Error("损坏的标记记录");
  const seen = new Set<string>();
  for (const item of raw.items) {
    if (!object(item) || typeof item.id !== "string" || !/^[a-f0-9-]{36}$/.test(item.id) || seen.has(item.id) ||
      !Number.isSafeInteger(item.tStartMs) || (item.tStartMs as number) < 0 || typeof item.label !== "string" || (item.label !== "" && !text(item.label, 80))) throw new Error("损坏的标记记录");
    seen.add(item.id);
  }
  return (raw.items as Bookmark[]).sort((a, b) => a.tStartMs - b.tStartMs);
}
export function changeBookmark(dir: string, raw: unknown, action: "add" | "delete", maxTimeMs: number): ActionResult {
  if (!object(raw)) return { ok: false, error: "无效的标记" };
  if (action === "add" && (!Number.isSafeInteger(raw.tStartMs) || (raw.tStartMs as number) < 0 || !Number.isFinite(maxTimeMs) || (raw.tStartMs as number) > maxTimeMs ||
      (raw.label !== undefined && raw.label !== "" && !text(raw.label, 80)))) return { ok: false, error: "标记时间须在录音内，名称最多 80 字" };
  if (action === "delete" && (typeof raw.bookmarkId !== "string" || !/^[a-f0-9-]{36}$/.test(raw.bookmarkId))) return { ok: false, error: "无效的标记" };
  try {
    let items = readBookmarks(dir);
    if (action === "add") {
      if (items.length >= 10_000) return { ok: false, error: "这场录音的标记已达上限" };
      items.push({ id: randomUUID(), tStartMs: raw.tStartMs as number, label: ((raw.label as string | undefined) ?? "").trim() });
    } else {
      if (!items.some(item => item.id === raw.bookmarkId)) return { ok: false, error: "标记已删除，请刷新" };
      items = items.filter(item => item.id !== raw.bookmarkId);
    }
    writeJson(join(dir, "bookmarks.json"), { schema_version: 1, items });
    return { ok: true };
  } catch { return { ok: false, error: "标记没能保存；已有记录保持不变，请检查文件后重试" }; }
}

function snippet(text: string, terms: string[]): string {
  const lower = text.toLocaleLowerCase();
  const found = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
  const start = Math.max(0, (found.length ? Math.min(...found) : 0) - 36);
  return `${start ? "…" : ""}${text.slice(start, start + 180).replace(/\s+/g, " ")}${text.length > start + 180 ? "…" : ""}`;
}
export function searchDetails(raw: unknown, details: Iterable<SessionDetail>): TranscriptSearchResult {
  if (!object(raw) || typeof raw.query !== "string" || raw.query.length > 200 || control.test(raw.query) ||
    (raw.limit !== undefined && (!Number.isInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > 100))) return { ok: false, error: "搜索最多 200 字，结果上限为 100 条" };
  const terms = [...new Set(raw.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean))];
  if (!terms.length) return { ok: true, hits: [], truncated: false };
  const limit = (raw.limit as number | undefined) ?? 50;
  const hits: Extract<TranscriptSearchResult, { ok: true }>["hits"] = [];
  for (const detail of details) {
    const title = detail.title.toLocaleLowerCase();
    const titleMatch = terms.every(term => title.includes(term));
    if (titleMatch) hits.push({ sessionId: detail.id, sessionTitle: detail.title, turnId: null, tStartMs: null, snippet: detail.title });
    if (hits.length > limit) return { ok: true, hits: hits.slice(0, limit), truncated: true };
    for (const turn of detail.turns) {
      const content = `${title}\n${turn.speaker}\n${turn.text}`.toLocaleLowerCase();
      // Title-only queries need one session result, unless a term also occurs in the turn.
      if (!terms.every(term => content.includes(term)) || (titleMatch && !terms.some(term => `${turn.speaker}\n${turn.text}`.toLocaleLowerCase().includes(term)))) continue;
      hits.push({ sessionId: detail.id, sessionTitle: detail.title, turnId: turn.id, tStartMs: turn.tStartMs, speaker: turn.speaker, revision: turn.correction?.revision, snippet: snippet(turn.text, terms) });
      if (hits.length > limit) return { ok: true, hits: hits.slice(0, limit), truncated: true };
    }
  }
  return { ok: true, hits, truncated: false };
}
