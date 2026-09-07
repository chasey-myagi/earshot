import { randomUUID } from "node:crypto";
import { lstat, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ExportFormat, ExportTranscriptInput, ExportTranscriptResult, SessionDetail } from "../shared/types";
import type { SessionStore } from "./store/sessions.ts";

type ChoosePath = (filename: string, format: ExportFormat) => Promise<string | null>;

function isInput(raw: unknown): raw is ExportTranscriptInput {
  if (!raw || typeof raw !== "object") return false;
  const input = raw as Partial<ExportTranscriptInput>;
  return typeof input.sessionId === "string" && /^[a-zA-Z0-9_-]+$/.test(input.sessionId)
    && (input.format === "json" || input.format === "txt");
}

function filename(title: string, format: ExportFormat): string {
  const clean = title.replace(/[\\/\x00-\x1f\x7f<>:"|?*]/g, " ").replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  // 60 Unicode characters leave room for the extension within a 255-byte filename.
  return `${[...clean].slice(0, 60).join("").trim() || "转录文本"}.${format}`;
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, "0")).join(":");
}

function document(detail: SessionDetail) {
  const { id, title, startedAt, endedAt, durationSec, status } = detail;
  return {
    schema_version: 1,
    session: { id, title, startedAt, endedAt, durationSec, status },
    turns: detail.turns.filter((turn) => !turn.partial && turn.text.trim()).map((turn) => ({
      id: turn.id,
      track: turn.track,
      speaker: turn.track === "you" ? "你" : turn.speaker || "对方",
      tStartMs: turn.tStartMs,
      ...(turn.tEndMs === undefined ? {} : { tEndMs: turn.tEndMs }),
      text: turn.text,
    })),
  };
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function outputPath(rootDir: string, path: string): Promise<string> {
  const root = resolve(rootDir);
  const target = resolve(path);
  const canonicalRoot = await realpath(root);
  const canonicalTarget = join(await realpath(dirname(target)), basename(target));
  if (within(root, target) || within(canonicalRoot, canonicalTarget)) {
    throw new Error("请选择 Earshot 数据目录以外的保存位置");
  }
  const info = await lstat(canonicalTarget).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  // Includes dangling links: never follow a user-selected link into source data.
  if (info?.isSymbolicLink()) throw new Error("请选择普通文件，不能导出到符号链接");
  return canonicalTarget;
}

async function save(path: string, content: string): Promise<void> {
  const temporary = join(dirname(path), `.earshot-export-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function exportTranscript(
  store: SessionStore,
  raw: unknown,
  choosePath: ChoosePath,
  onSaved?: (path: string) => void,
): Promise<ExportTranscriptResult> {
  if (!isInput(raw)) return { ok: false, error: "无法导出，请选择 TXT 或 JSON 格式" };
  try {
    const detail = store.getDetail(raw.sessionId);
    if (!detail) return { ok: false, error: "找不到这场会" };
    if (detail.status === "recording") return { ok: false, error: "停止录音后即可导出" };
    const doc = document(detail);
    if (!doc.turns.length) return { ok: false, error: "还没有可导出的转录文本" };
    // Serialize before the dialog: a background job may publish a new draft while it is open.
    const content = raw.format === "json" ? `${JSON.stringify(doc, null, 2)}\n`
      : `${doc.session.title}\n开始时间：${doc.session.startedAt}\n\n${doc.turns
        .map((turn) => `[${clock(turn.tStartMs)}] ${turn.speaker}：${turn.text}`).join("\n")}\n`;
    const path = await choosePath(filename(detail.title, raw.format), raw.format);
    if (!path) return { ok: true, canceled: true };
    const savedPath = await outputPath(store.rootDir, path);
    await save(savedPath, content);
    onSaved?.(savedPath);
    return { ok: true, canceled: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `导出没完成：${error.message}` : "导出没完成，请换个保存位置重试" };
  }
}
