export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatStartTime(iso: string): string {
  const date = new Date(iso);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function isSameDay(iso: string, day: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === day.getFullYear() &&
    d.getMonth() === day.getMonth() &&
    d.getDate() === day.getDate()
  );
}

export function formatListWhen(iso: string, now = new Date()): string {
  if (isSameDay(iso, now)) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(iso, yesterday)) return "昨天";
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatDurationShort(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.floor(sec))} 秒`;
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    const rem = m % 60;
    return rem ? `${h} 小时 ${rem} 分` : `${h} 小时`;
  }
  return `${m} 分`;
}

export function formatDurationLong(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.floor(sec))} 秒`;
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    const rem = m % 60;
    return rem ? `${h} 小时 ${rem} 分钟` : `${h} 小时`;
  }
  return `${m} 分钟`;
}

export function formatClock(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

export function formatTurnClock(tStartMs: number, startedAt: string | null): string {
  if (startedAt) {
    const t = new Date(new Date(startedAt).getTime() + tStartMs);
    return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  }
  return formatClock(tStartMs / 1000);
}
