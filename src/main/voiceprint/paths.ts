import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const VOICEPRINT_MODEL = "3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx";

function repoModelDirs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, "../../models"),
    join(here, "../../../models"),
    join(process.cwd(), "models"),
  ];
}

export function findVoiceprintModel(opts?: { resourcesPath?: string; repoRoot?: string }): string | null {
  const dirs = [
    opts?.resourcesPath ? join(opts.resourcesPath, "models") : "",
    typeof process.resourcesPath === "string" && process.resourcesPath ? join(process.resourcesPath, "models") : "",
    opts?.repoRoot ? join(opts.repoRoot, "models") : "",
    ...repoModelDirs(),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const path = join(dir, VOICEPRINT_MODEL);
    if (existsSync(path)) return path;
  }
  return null;
}
