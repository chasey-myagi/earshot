import type { ActionResult, PermissionState } from "../../shared/types";

export type ProbePermissions = {
  microphone: PermissionState;
  screen: PermissionState;
};

export function startBlockers(input: {
  busy: boolean;
  hasApiKey: boolean;
  permissions: ProbePermissions;
}): ActionResult | null {
  if (input.busy) return { ok: false, error: "正在录音", code: "busy" };
  if (!input.hasApiKey) return { ok: false, error: "没有密钥不能开始", code: "no_key" };
  if (input.permissions.microphone !== "granted") {
    return { ok: false, error: "需要麦克风权限", code: "no_mic" };
  }
  if (input.permissions.screen !== "granted") {
    return { ok: false, error: "需要屏幕录制权限", code: "no_screen" };
  }
  return null;
}

export function micRequestResult(granted: boolean): ActionResult {
  if (granted) return { ok: true };
  return { ok: false, error: "需要麦克风权限", code: "no_mic" };
}
