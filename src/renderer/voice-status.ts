import type { SessionDetail } from "../shared/types";

export function voiceRegistrationMessage(records: SessionDetail["voiceRegistrations"], name: string): string | undefined {
  const states = records?.filter(row => row.name === name).map(row => row.status) ?? [];
  if (!states.length) return;
  if (states.includes("running")) return "名字已保存，正在记住声音…";
  if (states.includes("pending")) return "名字已保存，撤销期结束后记住声音。";
  if (states.includes("unavailable")) return "名字已保存，声音暂未记住。可重试。";
  if (states.includes("conflicting")) return "名字已保存，片段中可能有不同声音，暂不用于跨会识别。";
  if (states.includes("insufficient")) return "名字已保存，清晰的声音片段不足。";
  if (states.includes("stale")) return "本场分组已更新，声音尚未记住。";
  return "已记住声音，下次录音会尝试自动识别。";
}
