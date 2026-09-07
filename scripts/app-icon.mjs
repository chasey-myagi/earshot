import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ICON_FILE = "Earshot.icns";

export function installAppIcon(appPath) {
  const resources = join(appPath, "Contents/Resources");
  mkdirSync(resources, { recursive: true });
  copyFileSync(fileURLToPath(new URL("../assets/Earshot.icns", import.meta.url)), join(resources, APP_ICON_FILE));
  copyFileSync(fileURLToPath(new URL("../assets/earshot-icon.png", import.meta.url)), join(resources, "earshot-icon.png"));
}
