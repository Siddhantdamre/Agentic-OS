export const BACKFILL_MAX_WINDOW_DAYS = 30;
export interface BusinessHours { start: string; end: string; days: number[]; }
export interface FirstObservation { id: string; headline: string; detail: string; threadCount: number; conversationIds: string[]; shownAt: string; }
export interface TrajectorySnapshot { approved: number; considered: number; graduated: string[]; neverGraduate: string[]; message: string; }
export interface StagedRolloutWeek { week: number; stage: 0 | 1 | 2 | 3; title: string; description: string; }
export interface BackfillJob { id: string; windowDays: number; status: 'pending' | 'running' | 'completed' | 'failed'; loopsImported: number; wonImported: number; error: string | null; startedAt: string | null; finishedAt: string | null; }
export const DEFAULT_BUSINESS_HOURS: BusinessHours = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] };
export const NEVER_GRADUATE = ['refunds', 'deletions', 'anything a customer sees until stage 3'];
export const STAGED_ROLLOUT_PLAN: StagedRolloutWeek[] = [
  { week: 1, stage: 0, title: 'Notice', description: 'It watches. Zero actions, zero risk — overdue threads surface as observations.' },
  { week: 2, stage: 0, title: 'Draft', description: 'It drafts replies for you to correct. Still zero autonomous sends.' },
  { week: 3, stage: 1, title: 'Act internally', description: 'Assign, schedule, update, remind. Reversible only.' },
  { week: 4, stage: 2, title: 'Act externally, gated', description: 'Customer-visible sends require your approval until trust is earned.' },
];
export function toRolloutWeekViews(currentStage: number) {
  return STAGED_ROLLOUT_PLAN.map((week) => ({ week: week.week, label: `Week ${week.week}`, headline: week.title, body: week.description, current: currentStage === week.stage }));
}
export function clampBackfillWindow(days: unknown): number {
  const n = typeof days === 'number' ? days : Number(days);
  if (!Number.isFinite(n) || n <= 0) return BACKFILL_MAX_WINDOW_DAYS;
  return Math.min(BACKFILL_MAX_WINDOW_DAYS, Math.floor(n));
}
export function parseBusinessHours(value: unknown): BusinessHours {
  if (!value || typeof value !== 'object') return { ...DEFAULT_BUSINESS_HOURS };
  const raw = value as Record<string, unknown>;
  const start = typeof raw.start === 'string' && /^\d{2}:\d{2}$/.test(raw.start) ? raw.start : '09:00';
  const end = typeof raw.end === 'string' && /^\d{2}:\d{2}$/.test(raw.end) ? raw.end : '18:00';
  const days = Array.isArray(raw.days) ? raw.days.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6) : [1, 2, 3, 4, 5];
  return { start, end, days: days.length ? days : [1, 2, 3, 4, 5] };
}
export function parseBusinessHour(value: string, fallback: string): string { return /^\d{2}:\d{2}$/.test(value) ? value : fallback; }
export function isValidIanaTimezone(value: string): boolean {
  try { Intl.DateTimeFormat('en-GB', { timeZone: value }).format(new Date()); return value.length > 0 && value.length < 80; } catch { return false; }
}
export function buildTrajectory(approved: number, considered: number, graduated: string[]): TrajectorySnapshot {
  const safeApproved = Math.max(0, approved);
  const safeConsidered = Math.max(safeApproved, considered);
  const message = safeConsidered === 0
    ? "I'm still learning how you like things handled, so I'll check with you more often for the first couple of weeks."
    : `You've approved ${safeApproved} of my last ${safeConsidered} suggestions. Once we're consistent on a type of decision, I'll start handling it myself.`;
  return { approved: safeApproved, considered: safeConsidered, graduated, neverGraduate: [...NEVER_GRADUATE], message };
}
export function observationHeadline(threadCount: number, dayLabel: string): string {
  if (threadCount <= 0) return 'No unanswered threads in the last day — I will keep watching.';
  return `${threadCount} ${threadCount === 1 ? 'enquiry' : 'enquiries'} from ${dayLabel} have had no reply.`;
}
export function mapBackfillRow(row: { id: string; window_days: number; status: string; loops_imported: number; won_imported: number; error: string | null; started_at: Date | string | null; finished_at: Date | string | null; }): BackfillJob {
  const allowed = ['pending', 'running', 'completed', 'failed'] as const;
  const status = allowed.includes(row.status as (typeof allowed)[number]) ? (row.status as BackfillJob['status']) : 'pending';
  return { id: row.id, windowDays: row.window_days, status, loopsImported: row.loops_imported, wonImported: row.won_imported, error: row.error, startedAt: row.started_at ? new Date(row.started_at).toISOString() : null, finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null };
}
export function mapObservationRow(row: { id: string; headline: string; detail: string; thread_count: number; conversation_ids: string[]; shown_at: Date | string; }): FirstObservation {
  return { id: row.id, headline: row.headline, detail: row.detail, threadCount: row.thread_count, conversationIds: row.conversation_ids || [], shownAt: new Date(row.shown_at).toISOString() };
}
