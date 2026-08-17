/**
 * Pure employee router. Safe to import from the Temporal workflow isolate
 * (no Node, pg, or fetch). New employee = config on the roster — do not
 * hardcode a role into shared infra.
 *
 * route(work_item) -> { destination, employeeId, confidence, reason }
 * Always solo. Greetings never fan out. CrewWorkflow cap 3 is unchanged.
 */

export type RouteDestination = 'employee' | 'human' | 'dispatch';

export type EmployeeStatus = 'active' | 'paused';

export type RosterKey = 'sales' | 'support' | 'ops' | 'research' | 'finance' | 'dispatch' | 'other';

export interface RouteEmployee {
  id: string;
  name: string;
  role: string;
  persona: string;
  toolAllowlist: string[];
  status: EmployeeStatus;
  rosterKey?: RosterKey;
}

export interface WorkItemRouteInput {
  orgId: string;
  userMessage: string;
  channel?: string;
  /** Prior assignee / webhook default — NOT a name lock. */
  preferredEmployeeId?: string;
  employees: RouteEmployee[];
}

export interface RouteResult {
  destination: RouteDestination;
  employeeId?: string;
  employeeName: string;
  employeeRole: string;
  employeePersona: string;
  toolAllowlist: string[];
  confidence: number;
  reason: string;
  rosterKey?: RosterKey;
  locked: boolean;
}

const GREETING_RE =
  /^\s*(hi|hello|hey|yo|hola|namaste|good\s?(morning|afternoon|evening)|thanks|thank you|cheers)[\s!.,?]*$/i;

const ASK_TO_RE = /\bask\s+@?([A-Za-z][A-Za-z0-9._-]{1,40})\s+to\b/i;
const AT_MENTION_RE = /(?:^|\s)@([A-Za-z][A-Za-z0-9._-]{1,40})\b/;

/**
 * PM leak / fire / flood class. Route to human/dispatch — never ISA/sales.
 * Keywords are signals on the work item, not a hardcoded employee id.
 */
const EMERGENCY_RE = new RegExp(
  [
    '\\b(emergency|urgent\\s+emergency)\\b',
    '\\b(gas\\s+leak|carbon\\s+monoxide|co\\s+alarm)\\b',
    '\\b(burst\\s+pipe|water\\s+leak|leaking|flood(?:ing)?|fire|smoke|sparks?)\\b',
    '\\b(pm\\s+emergency|after-?hours\\s+emergency)\\b',
    '\\b(no\\s+heat|no\\s+power|electrical\\s+fire)\\b',
  ].join('|'),
  'i'
);

const KEYWORD_WEIGHTS: ReadonlyArray<{ key: RosterKey; pattern: RegExp; weight: number }> = [
  {
    key: 'finance',
    pattern: /\b(invoice|payment\s+link|razorpay|stripe|payout|collect\s+payment|pay\s+link)\b/i,
    weight: 0.85,
  },
  {
    key: 'research',
    pattern: /\b(cite|citation|comps?|research|search\s+the\s+web|look\s+up\s+docs?|web\s+search)\b/i,
    weight: 0.8,
  },
  {
    key: 'ops',
    pattern: /\b(spreadsheet|google\s+sheets?|sandbox|metrics|campaign|roas|analytics|numbers)\b/i,
    weight: 0.75,
  },
  {
    key: 'sales',
    pattern: /\b(lead|qualify|demo|outreach|pipeline|hubspot|deal|prospect)\b/i,
    weight: 0.7,
  },
  {
    key: 'support',
    pattern: /\b(ticket|refund|faq|order\s+status|helpdesk|sop|escalate)\b/i,
    weight: 0.7,
  },
];

export function isHumanDestination(destination: RouteDestination): boolean {
  switch (destination) {
    case 'human':
    case 'dispatch':
      return true;
    case 'employee':
      return false;
    default: {
      const _exhaustive: never = destination;
      return _exhaustive;
    }
  }
}

export function personaText(persona: unknown): string {
  if (persona == null) return '';
  if (typeof persona === 'string') return persona.trim();
  if (typeof persona === 'object') {
    const rec = persona as Record<string, unknown>;
    for (const key of ['text', 'description', 'persona', 'system'] as const) {
      if (typeof rec[key] === 'string' && rec[key].trim()) return rec[key];
    }
  }
  return '';
}

export function inferRosterKey(employee: Pick<RouteEmployee, 'name' | 'role' | 'persona' | 'toolAllowlist' | 'rosterKey'>): RosterKey {
  if (employee.rosterKey) return employee.rosterKey;
  const blob = `${employee.name} ${employee.role} ${employee.persona}`.toLowerCase();
  const tools = (employee.toolAllowlist || []).map((t) => t.toLowerCase().replace(/_/g, '-'));
  if (/\bdispatch\b/.test(blob)) return 'dispatch';
  if (/\bfinance\b|\bbooks\b|\binvoice\b/.test(blob) || tools.includes('stripe') || tools.includes('razorpay')) {
    return 'finance';
  }
  if (/\bresearch\b|\banalyst\b/.test(blob)) return 'research';
  if (/\bsales\b|\blead\b|\bisa\b/.test(blob)) return 'sales';
  if (/\bops\b|\bmarketing\b|\banalytics\b|\bmarcus\b/.test(blob)) return 'ops';
  if (/\bsupport\b|\bticket\b|\bemm?a\b/.test(blob)) return 'support';
  return 'other';
}

function activeEmployees(employees: RouteEmployee[]): RouteEmployee[] {
  return employees.filter((e) => e.status === 'active');
}

function matchEmployeeByName(employees: RouteEmployee[], raw: string): RouteEmployee | undefined {
  const needle = raw.replace(/^@/, '').trim().toLowerCase();
  if (!needle) return undefined;
  const pool = activeEmployees(employees);
  const exact = pool.find((e) => e.name.toLowerCase() === needle);
  if (exact) return exact;
  return pool.find((e) => e.name.toLowerCase().startsWith(needle) && needle.length >= 3);
}

function emptyRoute(reason: string, destination: RouteDestination): RouteResult {
  return {
    destination,
    employeeName: destination === 'employee' ? '' : 'human',
    employeeRole: destination === 'dispatch' ? 'dispatch' : 'human',
    employeePersona: '',
    toolAllowlist: [],
    confidence: 1,
    reason,
    locked: false,
  };
}

function toResult(employee: RouteEmployee, confidence: number, reason: string, locked: boolean): RouteResult {
  return {
    destination: 'employee',
    employeeId: employee.id,
    employeeName: employee.name,
    employeeRole: employee.role,
    employeePersona: employee.persona,
    toolAllowlist: employee.toolAllowlist,
    confidence,
    reason,
    rosterKey: inferRosterKey(employee),
    locked,
  };
}

function pickByRoster(active: RouteEmployee[], key: RosterKey): RouteEmployee | undefined {
  return active.find((e) => inferRosterKey(e) === key);
}

function parseNameLock(message: string, employees: RouteEmployee[]): RouteEmployee | undefined {
  const ask = ASK_TO_RE.exec(message);
  if (ask?.[1]) {
    const hit = matchEmployeeByName(employees, ask[1]);
    if (hit) return hit;
  }
  const at = AT_MENTION_RE.exec(message);
  if (at?.[1]) {
    const hit = matchEmployeeByName(employees, at[1]);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Choose one employee (or human/dispatch) for a work item.
 * Never returns a crew. Greetings stay solo support.
 */
export function route(workItem: WorkItemRouteInput): RouteResult {
  const message = (workItem.userMessage || '').trim();
  const employees = workItem.employees || [];
  const active = activeEmployees(employees);

  if (EMERGENCY_RE.test(message)) {
    const dispatch = pickByRoster(active, 'dispatch');
    if (dispatch) {
      return toResult(dispatch, 1, 'emergency keyword — dispatch, not ISA', false);
    }
    return emptyRoute('emergency keyword — human/dispatch, not ISA', 'dispatch');
  }

  const locked = parseNameLock(message, employees);
  if (locked) {
    return toResult(locked, 1, `name lock: ${locked.name}`, true);
  }

  if (active.length === 0) {
    return emptyRoute('no active employees', 'human');
  }

  if (GREETING_RE.test(message)) {
    const support = pickByRoster(active, 'support') || active[0];
    return toResult(support, 1, 'greeting — solo support, no crew', false);
  }

  const scores = new Map<string, number>();
  for (const emp of active) scores.set(emp.id, 0.1);

  for (const { key, pattern, weight } of KEYWORD_WEIGHTS) {
    if (!pattern.test(message)) continue;
    const emp = pickByRoster(active, key);
    if (!emp) continue;
    scores.set(emp.id, Math.max(scores.get(emp.id) || 0, weight));
  }

  let best = active[0];
  let bestScore = scores.get(best.id) || 0;
  for (const emp of active) {
    const score = scores.get(emp.id) || 0;
    if (score > bestScore) {
      best = emp;
      bestScore = score;
    }
  }

  if (bestScore < 0.5) {
    const support = pickByRoster(active, 'support');
    if (support) {
      return toResult(support, 0.45, 'low confidence — support, not round-robin', false);
    }
  }

  return toResult(best, bestScore, 'keyword match', false);
}
