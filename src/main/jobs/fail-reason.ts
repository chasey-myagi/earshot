export function classifyJobFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (msg === "提交结果未知") return "提交结果未知；再次重试可能重新计费";
  if (msg === "云端任务未完成，请手动重试") return msg;
  if (msg === "任务记录损坏") return "本机任务记录损坏，无法安全续跑";
  if (msg === "云端任务已过期" || msg === "云端结果已过期") return "云端记录已过期，重试将重新处理录音";
  if (/^转写服务请求失败：HTTP (429|5\d\d)$/.test(msg)) return "转写服务暂时不可用，请稍后重试";
  if (/401|403|invalid.?api.?key|unauthorized|密钥/i.test(msg)) return "密钥不对";
  if (/timeout|ETIMEDOUT|timed out|超时/i.test(msg)) return "转写超时";
  if (/ECONN|ENOTFOUND|network|fetch failed|socket|网络/i.test(msg)) return "网络不通";
  // Provider messages may contain credentials or user data in any language.
  // Persist and display only fixed categories, never a cleaned-up substring.
  return "处理没完成";
}
