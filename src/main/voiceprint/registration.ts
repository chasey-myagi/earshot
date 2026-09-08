import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "../store/json.ts";
import type { EnrollmentResult } from "./enroll.ts";

export type RegistrationState = EnrollmentResult | "pending" | "running";
export type RegistrationRecord = {
  operationId: string; name: string; artifact: string; status: RegistrationState;
  notBefore: number; attempts: number;
};
export type RegistrationRecords = Record<string, RegistrationRecord>;
const fileName = "voice-registration.json";

export function readRegistrations(dir: string): RegistrationRecords {
  const path = join(dir, fileName);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, value]) => {
      if (!value || typeof value !== "object") return false;
      const row = value as RegistrationRecord;
      return typeof row.operationId === "string" && typeof row.name === "string" && typeof row.artifact === "string"
        && ["pending", "running", "remembered", "insufficient", "conflicting", "unavailable", "stale"].includes(row.status)
        && Number.isFinite(row.notBefore) && Number.isFinite(row.attempts);
    })) as RegistrationRecords;
  } catch { return {}; }
}

export function writeRegistrations(dir: string, records: RegistrationRecords): void {
  writeJson(join(dir, fileName), records);
}
