/**
 * Channel quiet hours + do-not-contact helpers.
 * Safe for Temporal workflow isolates (no Node, pg, or fetch).
 */

export const DEFAULT_QUIET_START_HOUR = 21;
export const DEFAULT_QUIET_END_HOUR = 8;
export const MAX_NURTURE_FANOUT = 3;
export const MAX_STALE_CHASE = 10;

export type QuietHoursWindow = {
  startHour: number;
  endHour: number;
  timeZone: string;
};

export function defaultQuietHours(timeZone = 'UTC'): QuietHoursWindow {
  return {
    startHour: DEFAULT_QUIET_START_HOUR,
    endHour: DEFAULT_QUIET_END_HOUR,
    timeZone: timeZone || 'UTC',
  };
}

/** Overnight window: startHour (inclusive) → endHour (exclusive), wrapping midnight. */
export function isQuietHour(hour: number, window: QuietHoursWindow): boolean {
  const start = window.startHour;
  const end = window.endHour;
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function hoursUntilQuietEnd(hour: number, window: QuietHoursWindow): number {
  if (!isQuietHour(hour, window)) return 0;
  if (hour < window.endHour) return window.endHour - hour;
  return 24 - hour + window.endHour;
}

export type NurtureCancelReason = 'inbound' | 'takeover' | 'do_not_contact' | 'rejected' | 'emergency_stop';

export type NurtureTick = 'T+1d' | 'T+3d' | 'T+7d';

export function nurtureWorkflowId(orgId: string, conversationId: string): string {
  return `nurture-${orgId}-${conversationId}`;
}

export function planExecuteWorkflowId(orgId: string, planId: string): string {
  return `plan-execute-${orgId}-${planId}`;
}

export function ownerBriefingWorkflowId(orgId: string): string {
  return `owner-briefing-${orgId}`;
}

export function staleChaseWorkflowId(orgId: string, runKey?: string): string {
  if (runKey) return `stale-chase-${orgId}-${runKey}`;
  return `stale-chase-${orgId}`;
}

export function insightActionWorkflowId(orgId: string, metricId: string, runKey?: string): string {
  const safe = metricId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  if (runKey) return `insight-action-${orgId}-${safe}-${runKey}`;
  return `insight-action-${orgId}-${safe}-${Date.now()}`;
}
