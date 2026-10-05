/**
 * Pure employee router. Safe to import from the Temporal workflow isolate
 * (no Node, pg, or fetch). New employee = config on the roster — do not
 * hardcode a role into shared infra.
 *
 * route(work_item) -> { destination, employeeId, confidence, reason }
 * Always solo. Greetings never fan out. Ask AI Team mode hard-cap is 3
 * (product lock). CrewWorkflow hard-cap is MAX_CREW_SPAWN (3).
 */

export type RouteDestination = 'employee' | 'human' | 'dispatch';

export type EmployeeStatus = 'active' | 'paused';

export type RosterKey =
  | 'sales'
  | 'support'
  | 'ops'
  | 'research'
  | 'finance'
  | 'dispatch'
  | 'executive'
  | 'other';

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

const GENERAL_RE = /\b(who\s+(is|are|was|were|founded)|founders?|tell me about|what(?:'s| is| are))\b/i;

/** Daily / morning / executive brief — stays with Executive, not Research. */
export const DAILY_BRIEF_RE =
  /\b((today'?s|daily|morning|executive|standup)\s+brief|brief\s+me\s+(for\s+)?today|status\s+across\s+(sales|support|ops|the\s+org))\b/i;

const GREETING_RE =
  /^\s*(hi|hello|hey|yo|hola|namaste|good\s?(morning|afternoon|evening)|thanks|thank you|cheers)[\s!.,?]*$/i;

/** "Who are you / what can you do" is about the assistant, not a founder/company lookup. */
const SELF_INTRO_RE =
  /\b(who\s+are\s+you|what\s+(can|do)\s+you\s+(do|help)|introduce\s+yourself|what\s+are\s+you)\b/i;

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

/**
 * Score the *user message* against role keywords, then pick the employee whose
 * name/role matches `prefer`. Never scan persona prose for other roles' words —
 * that stole jobs (Growth "executive outreach" → Executive, Customer "Finance"
 * → Finance).
 */
const KEYWORD_WEIGHTS: ReadonlyArray<{ key: RosterKey; pattern: RegExp; weight: number; prefer?: RegExp }> = [
  // Customer Resolution — CRM/ticket/refund/risk (prefer name Customer over Emma).
  {
    key: 'support',
    pattern:
      /\b(refunds?|chargebacks?|charge[\s-]?backs?|money[\s-]?back|returns?|return\s+window)\b/i,
    weight: 0.95,
    prefer: /\bcustomer\b/,
  },
  {
    key: 'support',
    pattern:
      /\b(zendesk|intercom|ticket\s+history|(?:open\s+a\s+)?(?:zendesk\s+)?tickets?|angry\s+email|shipping\s+delay|open\s+promises?|conversations?\s+are\s+at[\s-]?risk)\b/i,
    weight: 0.92,
    prefer: /\bcustomer\b/,
  },
  {
    key: 'support',
    pattern: /\b(hubspot|stripe|zendesk|intercom).{0,40}\b(hubspot|stripe|zendesk|intercom|ticket)\b/i,
    weight: 0.91,
    prefer: /\bcustomer\b/,
  },
  // Emma — FAQ / front-line chatter (open loops + at-risk *support* threads).
  {
    key: 'support',
    pattern: /\b(faq|helpdesk|open\s+loops?|at[\s-]?risk\s+support|whatsapp|order\s+status)\b/i,
    weight: 0.82,
    prefer: /\bemm?a\b|\bcustomer\s+support\b/,
  },
  // Emma / Customer — inbox triage (fetch/check emails, unread emails, mailbox). Not the bare word
  // "email": drafting or sending an email belongs to Sales / Marketing.
  {
    key: 'support',
    pattern:
      /\b(inbox|mailbox|mail\s+triage|(recent|unread|new|latest)\s+(e-?)?mails?|e?mails?\s+in\s+(my\s+)?gmail|gmail\s+(inbox|messages)|triage\s+(my\s+)?(inbox|e?mails?)|(check|fetch)\s+(my\s+)?(recent\s+)?(e-?)?(mails?|inbox))\b/i,
    weight: 0.88,
    prefer: /\bemm?a\b|\bcustomer\b/,
  },
  // Finance — pay/invoice/charge/billing (never refund-shaped).
  {
    key: 'finance',
    pattern:
      /\b(invoice|payment\s+link|pay\s+link|razorpay|payout|collect\s+payment|quickbooks|billing\s+usage|billing\s*\/\s*plan|charge\s+(this\s+)?card|create\s+(a\s+)?charge)\b/i,
    weight: 0.9,
    prefer: /\bfinance\b/,
  },
  {
    key: 'finance',
    pattern: /\b(stripe\s+payment\s+link|create\s+a\s+stripe\s+payment)\b/i,
    weight: 0.9,
    prefer: /\bfinance\b/,
  },
  // Operations — sheets, reconcile, calendar, work items, rent, showings.
  {
    key: 'ops',
    pattern:
      /\b(spreadsheet|google\s+sheets?|\bsheets?\b|reconcil|dedup|duplicate\s+(hubspot\s+)?contacts?|meeting\s+preps?|prep\s+briefs?|calendar|work\s+items?|discrepanc|overdue\s+expectations?|expected\s+vs\s+actual|rent\s+reminders?|book\s+a\s+showing|reassign\s+work|bump\s+that\s+task|set\s+priority)\b/i,
    weight: 0.88,
    prefer: /\boperations\b/,
  },
  // Operations brief / overdue / needs-attention asks (not overdue invoices, which are Finance).
  {
    key: 'ops',
    pattern:
      /\b(operations?\s+(brief|report|status|update|summary|digest)|overdue(?!\s+(invoices?|payments?|bills?))|needs?\s+(my\s+)?attention|stuck\s+(items?|tasks?)|sla\s+breach(?:es)?)\b/i,
    weight: 0.9,
    prefer: /\boperations\b/,
  },
  // Finance — revenue / recurring revenue / cash questions (refund-shaped asks are skipped below).
  {
    key: 'finance',
    pattern: /\b(mrr|arr|recurring\s+revenue|revenue|cash\s*flow|burn\s+rate|runway|profit|expenses?)\b/i,
    weight: 0.85,
    prefer: /\bfinance\b/,
  },
  // Growth — prospecting / lead discovery ("find companies we could sell to").
  {
    key: 'sales',
    pattern:
      /\b((find|discover|identify|source|list|build)\b.{0,40}\b(companies|businesses|prospects|leads|accounts)|could\s+sell\s+to|ideal\s+customer|icp)\b/i,
    weight: 0.87,
    prefer: /\bgrowth\b/,
  },
  // Marcus / Marketing — ads, GA, Search Console, GBP, campaign mail.
  {
    key: 'ops',
    pattern:
      /\b(ga4|google\s+analytics|search\s+console|business\s+profile|meta\s+ads?|google\s+ads?|ad[\s-]?spend|roas|campaign|ad[\s-]?lead)\b/i,
    weight: 0.88,
    prefer: /\bmarcus\b|\bmarketing\b/,
  },
  // Growth — lookalikes, signals, dormant, attribution, ROI.
  {
    key: 'sales',
    pattern:
      /\b(lookalikes?|buying\s+signals?|dormant\s+leads?|pipeline\s+attribution|pipeline\s+roi|website\s+visitors?|growth\s+pipeline|growth\s+opportunit)\b/i,
    weight: 0.88,
    prefer: /\bgrowth\b/,
  },
  // Sarah / Sales — CRM deals, Salesforce/Zoho/Apollo, demos, listings.
  {
    key: 'sales',
    pattern:
      /\b(salesforce|zoho|apollo|linkedin|schedule\s+a\s+(?:\d+-?min\s+)?demo|inquiry|inquiries|listing\s+match|qualify|prospect|hubspot\s+(contact|deal)|create\s+a\s+(hubspot\s+)?deal|opportunity\s+stage|vp\s+sales)\b/i,
    weight: 0.86,
    prefer: /\bsarah\b|\bsales\b/,
  },
  {
    key: 'sales',
    pattern: /\b(lead|demo|outreach|deal|pricing\s+negotiat)\b/i,
    weight: 0.72,
    prefer: /\bsarah\b|\bsales\b/,
  },
  // Research — web, sources, founder, summarize into brain.
  {
    key: 'research',
    pattern:
      /\b(cite|citation|comps?|research|search\s+the\s+web|web\s+search|look\s+up\s+docs?|founders?|founding|competitive\s+summary|org\s+memory|top\s+result|notion|google\s+drive|\bdrive\b)\b/i,
    weight: 0.84,
    prefer: /\bresearch\b/,
  },
  // Executive — briefs / cross-domain focus (DAILY_BRIEF_RE also covers many).
  {
    key: 'executive',
    pattern: /\b(focus\s+on\s+this\s+week|cross[\s-]?domain|org\s+status|insights?\s+for\s+(the\s+)?(week|org))\b/i,
    weight: 0.86,
    prefer: /\bexecutive\b/,
  },
];

/** Refund-shaped asks must not score Finance via stripe|payment keywords. */
const REFUND_SHAPED_RE =
  /\b(refunds?|chargebacks?|charge[\s-]?backs?|money[\s-]?back|returns?|return\s+window)\b/i;

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

export interface CallerDefaults {
  /** The employee the caller's defaults belong to (webhook default employee). */
  employeeId?: string;
  toolAllowlist: string[];
  employeeName: string;
  employeeRole: string;
  employeePersona: string;
}

/**
 * Merge a route() result with the caller's own defaults for the activity's
 * return value. A human/dispatch destination never inherits the caller's
 * identity or tool allowlist (EMP-B01) — nobody is going to execute tools as
 * "human"/"dispatch", so a real allowlist has no business attaching to it.
 * An employee destination falls back to the caller's defaults only when it is
 * the caller's own employee (EMP-B02). A different employee with an empty
 * card gets no tools (core only downstream), not the webhook default's list —
 * otherwise a blank custom employee inherited Customer's Stripe/WhatsApp.
 */
export function mergeRoutedForCaller(routed: RouteResult, caller: CallerDefaults): RouteResult & CallerDefaults {
  const isEmployee = routed.destination === 'employee';
  const isCallersOwn = isEmployee && Boolean(routed.employeeId) && routed.employeeId === caller.employeeId;
  return {
    ...routed,
    employeeName: isEmployee ? routed.employeeName || caller.employeeName : routed.employeeName,
    employeeRole: isEmployee ? routed.employeeRole || caller.employeeRole : routed.employeeRole,
    employeePersona: isCallersOwn ? routed.employeePersona || caller.employeePersona : routed.employeePersona,
    toolAllowlist: isCallersOwn && routed.toolAllowlist.length === 0 ? caller.toolAllowlist : routed.toolAllowlist,
  };
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

/**
 * Identity from name / role / explicit rosterKey / tools only.
 * Never scan persona prose — role words there belong to *other* employees
 * ("hand to Finance", "executive outreach") and must not re-key this row.
 */
export function inferRosterKey(employee: Pick<RouteEmployee, 'name' | 'role' | 'persona' | 'toolAllowlist' | 'rosterKey'>): RosterKey {
  if (employee.rosterKey) return employee.rosterKey;
  const blob = `${employee.name} ${employee.role}`.toLowerCase();
  const tools = (employee.toolAllowlist || []).map((t) => t.toLowerCase().replace(/_/g, '-'));
  if (/\bdispatch\b/.test(blob)) return 'dispatch';
  // Identity wins over tools. Customer carries Stripe for refunds and must
  // stay support; only a finance-named employee, or a pay-only allowlist, is finance.
  if (/\bexecutive\b/.test(blob)) return 'executive';
  if (/\bfinance\b/.test(blob)) return 'finance';
  if (/\bresearch\b/.test(blob)) return 'research';
  // Growth is scored via prefer /\bgrowth\b/ — do not share Sarah's sales bucket
  // or pickByRoster('sales') returns Growth (earlier on the default roster).
  if (/\bgrowth\b/.test(blob)) return 'other';
  if (/\bsales\b|\blead\s*gen|\bisa\b|\bsarah\b/.test(blob)) return 'sales';
  if (/\boperations\b|\bops\b/.test(blob)) return 'ops';
  if (/\bmarketing\b|\banalytics\b|\bmarcus\b/.test(blob)) return 'ops';
  // "Customer Support" (Emma) and "Customer Resolution" / name Customer → support.
  if (/\bsupport\b|\bcustomer\b|\bemm?a\b/.test(blob)) return 'support';
  const payOnly = tools.length > 0 && tools.every((t) => t === 'stripe' || t === 'razorpay');
  if (payOnly) return 'finance';
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

/** Lock a turn to one active employee — skips domain routing. */
export function lockToEmployee(employee: RouteEmployee, reason?: string): RouteResult {
  return toResult(employee, 1, reason || `Locked to ${employee.name}`, true);
}

function pickByRoster(active: RouteEmployee[], key: RosterKey): RouteEmployee | undefined {
  return active.find((e) => inferRosterKey(e) === key);
}

function pickPreferred(active: RouteEmployee[], prefer: RegExp): RouteEmployee | undefined {
  const hits = active.filter((e) => prefer.test(`${e.name} ${e.role}`.toLowerCase()));
  if (hits.length === 0) return undefined;
  // Prefer an exact name hit (Customer vs Emma both match /\bcustomer\b/ in role text).
  return hits.find((e) => prefer.test(e.name.toLowerCase())) || hits[0];
}

/** Prefer seeded Executive (role/name), never invent one. */
function pickExecutive(active: RouteEmployee[]): RouteEmployee | undefined {
  return (
    pickByRoster(active, 'executive') ||
    active.find((e) => /\bexecutive\b/i.test(`${e.name} ${e.role}`))
  );
}

/** Front-line support for greetings / low-confidence — Emma before Customer Resolution. */
function pickSupport(active: RouteEmployee[]): RouteEmployee | undefined {
  return (
    pickPreferred(active, /\bemm?a\b/) ||
    pickPreferred(active, /\bcustomer\s+support\b/) ||
    pickByRoster(active, 'support')
  );
}

/** When auto would fall to human / DareX Executive, use the org's Executive row. */
function preferExecutiveOrHuman(active: RouteEmployee[], reason: string): RouteResult {
  const executive = pickExecutive(active);
  if (executive) {
    return toResult(executive, 0.5, reason, false);
  }
  return emptyRoute(reason, 'human');
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
    const support = pickSupport(active) || active[0];
    return toResult(support, 1, 'greeting — solo support, no crew', false);
  }

  if (SELF_INTRO_RE.test(message)) {
    const support = pickSupport(active) || active[0];
    return toResult(support, 0.9, 'about the assistant — solo support, no crew', false);
  }

  // Daily / cross-domain brief stays with Executive (not Research).
  if (DAILY_BRIEF_RE.test(message)) {
    const executive = pickExecutive(active);
    if (executive) {
      return toResult(executive, 0.9, 'daily brief — Executive', false);
    }
  }

  const scores = new Map<string, number>();
  for (const emp of active) scores.set(emp.id, 0.1);

  for (const { key, pattern, weight, prefer } of KEYWORD_WEIGHTS) {
    if (!pattern.test(message)) continue;
    // stripe|payment finance keywords must not steal refund / return / money-back.
    if (key === 'finance' && REFUND_SHAPED_RE.test(message)) continue;
    const emp = (prefer ? pickPreferred(active, prefer) : undefined) || pickByRoster(active, key);
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

  // Founder / company research → Research (cite tools), not human/Executive.
  if (GENERAL_RE.test(message) && bestScore < 0.5) {
    const research = pickByRoster(active, 'research');
    if (research) {
      return toResult(research, 0.55, 'founder/company question — Research', false);
    }
    return preferExecutiveOrHuman(active, 'general question — executive, not a specialist');
  }

  if (bestScore < 0.5) {
    const support = pickSupport(active);
    if (support) {
      return toResult(support, 0.45, 'low confidence — support, not round-robin', false);
    }
    return preferExecutiveOrHuman(active, 'low confidence — Executive fallback');
  }

  return toResult(best, bestScore, 'keyword match', false);
}
