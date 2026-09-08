import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import type { FileAsrTurn } from "./file-asr.ts";
import { writeJson } from "../store/json.ts";
import { FILE_MODEL } from "./models.ts";

export type AsrCheckpoint = {
  key: string;
  stage: "upload" | "submitting" | "poll" | "done" | "failed";
  taskId?: string;
  usageId?: string;
  usageAt?: number;
  hotwordRevision?: string;
  vocabularyId?: string;
  updatedAt: number;
  rows?: FileAsrTurn[];
  diagnostics?: { at: number; stage: string; kind: "http" | "timeout" | "network"; httpStatus?: number; requestId?: string }[];
};

export async function audioKey(filePath: string, diarize: boolean, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify([FILE_MODEL, diarize]));
  for await (const chunk of createReadStream(filePath, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

export function readCheckpoint(path: string | undefined, key: string): AsrCheckpoint | undefined {
  if (!path || !existsSync(path)) return;
  // Do not silently resubmit a possibly paid task if its journal is damaged.
  let raw: AsrCheckpoint;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("任务记录损坏"); }
  if (!raw || typeof raw.key !== "string" || !/^[a-f0-9]{64}$/.test(raw.key)) throw new Error("任务记录损坏");
  if (raw.usageId !== undefined && (typeof raw.usageId !== "string" || !/^[a-zA-Z0-9-]{1,150}$/.test(raw.usageId))) throw new Error("任务记录损坏");
  if (raw.usageAt !== undefined && (!Number.isSafeInteger(raw.usageAt) || raw.usageAt <= 0)) throw new Error("任务记录损坏");
  if (raw.hotwordRevision !== undefined && (typeof raw.hotwordRevision !== "string" || !/^[a-f0-9]{64}$/.test(raw.hotwordRevision))) throw new Error("任务记录损坏");
  if (raw.vocabularyId !== undefined && (typeof raw.vocabularyId !== "string" || !/^vocab-[a-zA-Z0-9-]{1,150}$/.test(raw.vocabularyId))) throw new Error("任务记录损坏");
  if (raw.key !== key) return;
  if (!["upload", "submitting", "poll", "done", "failed"].includes(raw.stage)) throw new Error("任务记录损坏");
  if (raw.stage === "poll" && (typeof raw.taskId !== "string" || !raw.taskId)) throw new Error("任务记录损坏");
  if ((raw.stage === "done" || raw.rows !== undefined) && (!Array.isArray(raw.rows) || raw.rows.some(row => !row || typeof row.text !== "string"
    || !Number.isFinite(row.tStartMs) || row.tStartMs < 0))) throw new Error("任务记录损坏");
  return raw;
}

export function saveCheckpoint(path: string | undefined, value: AsrCheckpoint): void {
  if (!path) return;
  writeJson(path, value);
}
