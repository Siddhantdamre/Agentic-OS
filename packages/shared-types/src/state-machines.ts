/**
 * Canonical state machines (gap/15). Wins over 09 §B. Maps match 023 CHECK
 * constraints — if these lists diverge from the schema, the same bug shows
 * up as an application error and a constraint violation.
 */

export type EnquiryState = 'new' | 'assigned' | 'contacted' | 'overdue' | 'escalated' | 'closed';

export type EnquiryPriority = 'critical' | 'high' | 'medium' | 'low';

export type OpenLoopStatus = 'waiting' | 'scheduled' | 'monitoring' | 'escalated' | 'closed';

export type ExpectationStatus = 'pending' | 'met' | 'missed' | 'cancelled';

export type DecisionOutcome = 'executed' | 'deferred' | 'declined' | 'escalated' | 'suppressed';

export type AutonomyTier = 1 | 2 | 3 | 4;

export type EmployeeRole = 'growth' | 'customer' | 'operations';

export type ExpectationBasis = 'promise' | 'declared' | 'inferred';

export type DueBasis = 'explicit' | 'relative' | 'default';

export type Obligor = 'us' | 'them';

export type StateMachineName = 'enquiry' | 'open_loop' | 'expectation';

/** Matches 023 operational_enquiries_state_chk. */
export const ENQUIRY_TRANSITIONS: Record<EnquiryState, EnquiryState[]> = {
  new: ['assigned', 'closed'],
  assigned: ['contacted', 'overdue', 'closed'],
  contacted: ['overdue', 'escalated', 'closed'],
  overdue: ['contacted', 'escalated', 'closed'],
  escalated: ['contacted', 'closed'],
  closed: [],
};

export const OPEN_LOOP_TRANSITIONS: Record<OpenLoopStatus, OpenLoopStatus[]> = {
  waiting: ['scheduled', 'monitoring', 'escalated', 'closed'],
  scheduled: ['monitoring', 'waiting', 'escalated', 'closed'],
  monitoring: ['escalated', 'waiting', 'closed'],
  escalated: ['monitoring', 'closed'],
  closed: [],
};

export const EXPECTATION_TRANSITIONS: Record<ExpectationStatus, ExpectationStatus[]> = {
  pending: ['met', 'missed', 'cancelled'],
  missed: ['met', 'cancelled'],
  met: [],
  cancelled: [],
};

export const STATE_MACHINES = {
  enquiry: ENQUIRY_TRANSITIONS,
  open_loop: OPEN_LOOP_TRANSITIONS,
  expectation: EXPECTATION_TRANSITIONS,
} as const;

export const STATE_MACHINE_INITIAL: Record<StateMachineName, string> = {
  enquiry: 'new',
  open_loop: 'waiting',
  expectation: 'pending',
};

export const MACHINE_INITIAL = STATE_MACHINE_INITIAL;
export const MACHINE_TABLES: Record<StateMachineName, Record<string, string[]>> = {
  enquiry: ENQUIRY_TRANSITIONS,
  open_loop: OPEN_LOOP_TRANSITIONS,
  expectation: EXPECTATION_TRANSITIONS,
};

export function reachableFrom(table: Record<string, string[]>, initial: string): Set<string> {
  const seen = new Set<string>([initial]);
  const queue = [initial];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const next of table[cur] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

export function canTransition(machine: StateMachineName, from: string, to: string): boolean {
  if (from === to) return true;
  const table = MACHINE_TABLES[machine];
  return Boolean(table[from]?.includes(to));
}

export function assertTransition(machine: StateMachineName, from: string, to: string): void {
  const table = MACHINE_TABLES[machine];
  if (from === to) return;
  if (!table[from]) throw new Error(`unknown ${machine} state: ${from}`);
  if (!table[from].includes(to)) {
    throw new Error(`illegal ${machine} transition: ${from} -> ${to}`);
  }
}
