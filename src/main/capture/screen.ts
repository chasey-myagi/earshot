import { systemPreferences } from "electron";
import { createRequire } from "node:module";
import type { ActionResult, PermissionState } from "../../shared/types";
import { mapMediaStatus } from "./screen-status.ts";

let capturedThisRun = false;

type MacPermissions = {
  getAuthStatus: (type: string) => string;
  askForScreenCaptureAccess: (openPreferences?: boolean) => void;
};

let warnedNoModule = false;

function macPermissions(): MacPermissions | null {
  try {
    return createRequire(import.meta.url)("node-mac-permissions") as MacPermissions;
  } catch (err) {
    if (!warnedNoModule) {
      warnedNoModule = true;
      console.error("[earshot] node-mac-permissions 加载失败，屏幕权限探测退回 Electron API", err);
    }
    return null;
  }
}

export function noteScreenGranted(): void {
  capturedThisRun = true;
}

export function probeScreenPermission(): PermissionState {
  if (capturedThisRun) return "granted";
  const mac = macPermissions();
  const raw = mac ? mac.getAuthStatus("screen") : systemPreferences.getMediaAccessStatus("screen");
  const state = mapMediaStatus(raw);
  if (state === "granted") capturedThisRun = true;
  return state;
}

export async function requestScreenPermission(): Promise<ActionResult> {
  if (probeScreenPermission() === "granted") return { ok: true };
  // 系统级申请（CGRequestScreenCaptureAccess）：首次调用弹经典系统对话框，
  // 并把 Earshot 登记进「录屏与系统录音」列表。用户打开开关后需重启 app 生效。
  const mac = macPermissions();
  const before = mac ? mac.getAuthStatus("screen") : systemPreferences.getMediaAccessStatus("screen");
  mac?.askForScreenCaptureAccess();
  const after = mac ? mac.getAuthStatus("screen") : systemPreferences.getMediaAccessStatus("screen");
  console.error(`[earshot] 屏幕权限申请：module=${mac ? "ok" : "missing"} before=${before} after=${after}`);
  if (probeScreenPermission() === "granted") return { ok: true };
  return { ok: false, error: "需要屏幕录制权限", code: "no_screen" };
}
