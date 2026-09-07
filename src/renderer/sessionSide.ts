import type { SessionJobs } from "../shared/types";

/** 会单失败态：interaction.md「该项旁出现处理未完成」 */
export function sessionSideHint(jobs: SessionJobs): string | null {
  if (jobs.refined === "failed" || jobs.speakers === "failed") {
    return "处理未完成";
  }
  if (jobs.refined === "canceling" || jobs.speakers === "canceling") return "取消中";
  if (jobs.refined === "canceled" || jobs.speakers === "canceled") return "已取消";
  return null;
}
