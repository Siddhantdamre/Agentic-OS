/** Granular overdue copy — never round 5 minutes up to "1 day over". */
export function formatDeviation(dueAt: string | Date | null | undefined, nowMs = Date.now()): string | null {
  if (!dueAt) return null;
  const dueMs = dueAt instanceof Date ? dueAt.getTime() : new Date(dueAt).getTime();
  if (!Number.isFinite(dueMs)) return null;
  const overdueMs = nowMs - dueMs;
  if (overdueMs <= 0) return null;
  const mins = Math.floor(overdueMs / (60 * 1000));
  if (mins < 60) return `${Math.max(1, mins)}m overdue`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h overdue`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (remHours === 0) return `${days}d overdue`;
  return `${days}d ${remHours}h overdue`;
}
