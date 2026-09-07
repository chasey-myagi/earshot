import type { PermissionState } from "../../shared/types";

export function mapMediaStatus(status: string): PermissionState {
  // "granted" 来自 Electron systemPreferences；"authorized" 来自 node-mac-permissions
  if (status === "granted" || status === "authorized") return "granted";
  if (status === "denied" || status === "restricted") return "denied";
  return "undetermined";
}

/** macOS often reports screen as denied before the app is even on the list. */
export function screenNeedsAllow(state: PermissionState): boolean {
  return state !== "granted";
}
