/**
 * "Is each AI employee doing its job?" in plain words, from numbers the product already measures.
 *
 * Pure functions: the counts come in from agent-health-query.ts (measured in the database for one workspace) and a
 * status with its reasons comes out. A reason is a sentence an owner can act on, never a metric name.
 *
 * What it does not claim: that an employee is correct. It says whether the employee is alive, whether work is stuck
 * behind a person, whether its actions keep failing, and whether people keep rewriting or rejecting what it drafts.
 * A rate needs a small sample before it is mentioned (MIN_DECIDED_FOR_RATES), the same rule the Trust page uses.
 */

import { PULL_BACK } from './trust-evidence';

export type HealthStatus = 'stuck' | 'watch' | 'ok' | 'new' | 'paused';

export interface AgentHealthInput {
  name: string;
  role: string;
  status: string;
  createdAt: string;
  /** Last time the employee did something (a ledger decision or a decided approval), null if never. */
  lastActionAt: string | null;
  /** Approvals waiting for a person. */
  waiting: number;
  /** How long the oldest waiting approval has waited, in hours, null when none wait. */
  oldestWaitingHours: number | null;
  /** Approvals decided in the recent window (approved as is, approved edited, rejected). */
  decided: number;
  approvedAsIs: number;
  approvedEdited: number;
  rejected: number;
  /** Approved by a person, then failed when it ran. */
  failedToRun: number;
}

export interface AgentHealthResult {
  status: HealthStatus;
  reasons: string[];
}

export const STUCK_AFTER_HOURS = 48;
export const QUIET_AFTER_DAYS = 7;
export const NEW_FOR_DAYS = 3;
export const MIN_DECIDED_FOR_RATES = 5;
export const EDITED_SHARE_ON_WATCH = 0.4;
export const REJECTED_SHARE_ON_WATCH = 0.3;
/** Same thresholds the Trust page uses to suggest going back a level, so the two screens never disagree. */
export const FAILED_MIN = PULL_BACK.failedMin;
export const FAILED_SHARE = PULL_BACK.failedShare;

const DAY_MS = 86400000;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function assessAgent(i: AgentHealthInput, now: Date = new Date()): AgentHealthResult {
  if (i.status !== 'active') return { status: 'paused', reasons: [] };

  const ageDays = (now.getTime() - new Date(i.createdAt).getTime()) / DAY_MS;
  const idleDays = i.lastActionAt ? (now.getTime() - new Date(i.lastActionAt).getTime()) / DAY_MS : null;

  const stuck: string[] = [];
  const watch: string[] = [];

  if (i.waiting > 0 && i.oldestWaitingHours !== null && i.oldestWaitingHours > STUCK_AFTER_HOURS) {
    const days = Math.floor(i.oldestWaitingHours / 24);
    stuck.push(
      i.waiting === 1
        ? `1 approval has been waiting for ${days} days. Nothing happens until you decide.`
        : `${i.waiting} approvals are waiting; the oldest for ${days} days. Nothing happens until you decide.`,
    );
  }
  const approved = i.approvedAsIs + i.approvedEdited;
  if (i.failedToRun >= FAILED_MIN && approved > 0 && i.failedToRun / approved >= FAILED_SHARE) {
    stuck.push(`${i.failedToRun} of ${approved} approved actions failed to run.`);
  }

  if (!i.lastActionAt) watch.push('It has not done anything yet.');
  else if (idleDays !== null && idleDays > QUIET_AFTER_DAYS) {
    watch.push(`It has not done anything in ${Math.floor(idleDays)} days.`);
  }
  if (i.decided >= MIN_DECIDED_FOR_RATES) {
    if (i.approvedEdited / i.decided >= EDITED_SHARE_ON_WATCH) {
      watch.push(`You rewrote ${i.approvedEdited} of its ${i.decided} drafts before approving.`);
    }
    if (i.rejected / i.decided >= REJECTED_SHARE_ON_WATCH) {
      watch.push(`You turned down ${i.rejected} of ${i.decided}.`);
    }
  }

  // A brand new employee has nothing to judge yet, unless work is already stuck behind a person.
  if (!stuck.length && !i.lastActionAt && ageDays < NEW_FOR_DAYS && i.decided === 0) return { status: 'new', reasons: [] };

  if (stuck.length) return { status: 'stuck', reasons: [...stuck, ...watch] };
  if (watch.length) return { status: 'watch', reasons: watch };
  return { status: 'ok', reasons: [] };
}

const ORDER: Record<HealthStatus, number> = { stuck: 0, watch: 1, ok: 2, new: 3, paused: 4 };

/** What needs a person comes first; the sort is stable so equal statuses keep their order. */
export function orderByAttention<T extends { status: HealthStatus }>(rows: T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ORDER[a.r.status] - ORDER[b.r.status] || a.i - b.i)
    .map((x) => x.r);
}

/** The worker's heartbeat for one background activity in this workspace (agent_activity_health). */
export interface BackgroundCheck {
  activity: string;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  failCount: number;
}
/** A check that finished before but has not for this long is treated as not running. */
export const CHECK_SILENT_AFTER_HOURS = 24;

export interface WorkspaceHealthInput {
  /** Heartbeat rows; absent or empty means nothing has been recorded yet, which is not a problem to report. */
  backgroundChecks?: BackgroundCheck[];
  /** Customer messages that failed to arrive and are waiting for a retry. */
  webhookFailuresWaiting: number;
  killSwitch: boolean;
}
export interface WorkspaceNote {
  level: 'stuck' | 'watch';
  text: string;
}

export function assessWorkspace(i: WorkspaceHealthInput, now: Date = new Date()): WorkspaceNote[] {
  const notes: WorkspaceNote[] = [];
  if (i.killSwitch) notes.push({ level: 'stuck', text: 'Your AI team is switched off. Nothing will run until you switch it back on.' });
  if (i.webhookFailuresWaiting > 0) {
    notes.push({
      level: 'watch',
      text: `${plural(i.webhookFailuresWaiting, 'customer message', 'customer messages')} failed to arrive and ${i.webhookFailuresWaiting === 1 ? 'is' : 'are'} waiting for a retry.`,
    });
  }
  const failing: BackgroundCheck[] = [];
  const silent: number[] = [];
  for (const c of i.backgroundChecks ?? []) {
    const ok = c.lastOkAt ? new Date(c.lastOkAt).getTime() : null;
    const err = c.lastErrorAt ? new Date(c.lastErrorAt).getTime() : null;
    if (err !== null && (ok === null || err > ok)) failing.push(c);
    else if (ok !== null) {
      const hours = (now.getTime() - ok) / 3_600_000;
      if (hours > CHECK_SILENT_AFTER_HOURS) silent.push(hours);
    }
  }
  if (failing.length) {
    const reason = failing[0].lastError;
    notes.push({
      level: 'watch',
      text: failing.length === 1
        ? `A background check failed on its last run${reason ? ` (${reason})` : ''}.`
        : `${failing.length} background checks failed on their last run.`,
    });
  }
  if (silent.length) {
    const days = Math.floor(Math.max(...silent) / 24);
    notes.push({
      level: 'watch',
      text: silent.length === 1
        ? `A background check has not run for ${days} days.`
        : `${silent.length} background checks have not run for up to ${days} days.`,
    });
  }
  return notes;
}
