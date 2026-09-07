import type { SessionJobs } from "../shared/types";

/** work-bar 文案按实际 running 任务分支，不撒谎 */
export function workBarMessage(jobs: SessionJobs): string {
  const refined = jobs.refined === "running";
  const speakers = jobs.speakers === "running";
  if (refined && speakers) return "正在转写录音并区分说话人";
  if (refined) return "正在转写录音";
  if (speakers) return "正在区分说话人";
  return "正在处理";
}

export type WorkFeedback = { kind: 'failed' | 'canceling' | 'canceled'; text: string; retry?: 'refined' | 'speakers' };
const failureText = (stage: string, reason?: string) => `${stage}未完成${reason && reason !== '处理没完成' ? `：${reason}` : ''}`;
export function workFeedback(jobs: SessionJobs): WorkFeedback[] {
  if (jobs.refined === 'canceling' || jobs.speakers === 'canceling') return [{ kind: 'canceling', text: '正在取消…' }];
  const notices: WorkFeedback[] = [];
  if (jobs.refined === 'canceled') notices.push({ kind: 'canceled', text: '处理已取消', retry: 'refined' });
  else if (jobs.speakers === 'canceled') notices.push({ kind: 'canceled', text: '说话人区分已取消', retry: 'speakers' });
  const both = jobs.refined === 'failed' && jobs.speakers === 'failed' && jobs.failedReason === jobs.speakersFailReason;
  if (jobs.refined === 'failed') notices.push({ kind: 'failed', text: failureText(both ? '录音处理' : '录音转写', jobs.failedReason), retry: 'refined' });
  if (jobs.speakers === 'failed' && !both) notices.push({ kind: 'failed', text: failureText('区分说话人', jobs.speakersFailReason), retry: 'speakers' });
  return notices;
}
