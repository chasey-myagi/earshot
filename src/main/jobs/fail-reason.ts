export function classifyJobFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/401|403|invalid.?api.?key|unauthorized|密钥/i.test(msg)) return "密钥不对";
  if (/timeout|ETIMEDOUT|timed out|超时/i.test(msg)) return "转写超时";
  if (/ECONN|ENOTFOUND|network|fetch failed|socket|网络/i.test(msg)) return "网络不通";
  // Provider messages may contain credentials or user data in any language.
  // Persist and display only fixed categories, never a cleaned-up substring.
  return "处理没完成";
}
