/**
 * What each employee does when nobody has asked it anything.
 *
 * An employee in this system was an identity and a permission set — a name, a
 * role, a persona and a tool allowlist — and nothing that said what it *does*.
 * Work only ever arrived as an inbound customer message, so an employee with no
 * inbound traffic did nothing at all, forever. Eight of nine in the demo
 * workspace held zero actions and zero threads while looking fully staffed.
 *
 * A duty closes that: a standing instruction the employee carries out on a
 * schedule, through the same AutonomousAgentWorkflow that handles a customer
 * message. Reusing that engine is the point — the tool loop, the allowlist
 * check, the critic, supervision and attribution all apply unchanged. A duty is
 * not a second kind of agent; it is a message the system writes instead of a
 * customer.
 *
 * ── TWO RULES THAT MAKE THIS SAFE TO RUN UNATTENDED ────────────────────────
 *
 * 1. A DUTY LOOKS AND REPORTS. IT DOES NOT ACT.
 *    Every duty below is read-only. Nothing sends, books, charges or replies to
 *    a customer. An unattended loop that can act on the outside world is a
 *    different product with a different risk profile, and it is not this one.
 *
 * 2. A DUTY RUNS WITH THE MINIMUM TOOL, NOT THE EMPLOYEE'S FULL AUTHORITY.
 *    Sarah holds gmail, whatsapp, hubspot and a calendar. Her duty runs with
 *    `database_query` alone. Holding a tool is permission to use it when a
 *    human is in the loop; it is not permission to use it at 6am because a
 *    timer fired. `dutyAllowlist` is deliberately the duty's need intersected
 *    with what the employee holds — never the union.
 *
 * Both rules are asserted in duties.test.ts, because they are the kind of thing
 * that erodes quietly the first time somebody wants a duty to "just send it".
 */

/** A tool that needs no external credential works in any workspace today. */
const NEEDS_NO_CREDENTIAL = new Set(['database_query', 'metrics', 'web_extract', 'file_ops']);

/**
 * Tools reachable only with a key in the environment. Deliberately small: an
 * OAuth tool is never "live" from an env var — it needs a per-tenant Nango
 * connection — so those are handled by `liveOauthProviders` at the call site
 * rather than guessed here.
 */
const KEY_GATED: Record<string, string[]> = {
  web_search: ['JINA_API_KEY', 'JINA_READ_API_KEY'],
  whatsapp: ['META_ACCESS_TOKEN'],
  razorpay: ['RAZORPAY_KEY_ID'],
  twilio: ['TWILIO_ACCOUNT_SID'],
};

export interface Duty {
  /** Stable id, used as the idempotency scope for a day's run. */
  id: string;
  /** Exact `role` string from the pack manifests. */
  role: string;
  /** One line an operator would recognise as this person's morning job. */
  summary: string;
  /** The tool the duty cannot be done without. */
  needs: string;
  /**
   * The standing instruction. Written for a voice agent's constraints: short,
   * evidence-bound, and explicit that silence is a valid answer. "Report
   * nothing" must be an acceptable outcome or the model will invent something
   * to justify the run.
   */
  instruction: string;
}

export const DUTIES: Duty[] = [
  {
    id: 'sales.unworked-inquiries',
    role: 'Sales / front-of-house',
    summary: 'Find people who asked something and never got an answer.',
    needs: 'database_query',
    instruction:
      'Query this workspace for conversations where the most recent message is from the '
      + 'customer and no reply followed. List at most five, oldest first, with the contact '
      + 'and how long they have waited. If there are none, say exactly that. '
      + 'Do not contact anyone. Do not estimate. Report only rows you retrieved.',
  },
  {
    id: 'support.needs-attention',
    role: 'Support / success',
    summary: 'Find threads that stalled waiting on a person.',
    needs: 'database_query',
    instruction:
      'Query this workspace for conversations with status needs_attention, and for open '
      + 'conversations with no activity in over 48 hours. Report the count of each and list '
      + 'at most five, oldest first. If both are zero, say so plainly. '
      + 'Do not reply to anyone. Report only rows you retrieved.',
  },
  {
    id: 'ops.kpi-movement',
    role: 'Ops / analyst',
    summary: 'Check the numbers and flag what moved.',
    needs: 'metrics',
    instruction:
      'Read this workspace KPIs. Report any metric that moved materially against its '
      + 'previous period, with both values and the direction. Name the metric exactly as the '
      + 'tool returned it. If nothing moved materially, say that. '
      + 'Never state a number the tool did not return, and never infer a cause.',
  },
  {
    id: 'isa.unqualified-leads',
    role: 'Buyer ISA',
    summary: 'Find new enquiries nobody has qualified yet.',
    needs: 'database_query',
    instruction:
      'Query this workspace for conversations started in the last seven days that have no '
      + 'recorded qualification and no owner. List at most five with the contact and when they '
      + 'arrived. If there are none, say so. Do not contact anyone. '
      + 'Never state a budget, requirement or timeline that is not in the retrieved rows.',
  },
  {
    id: 'listings.incomplete',
    role: 'Listing coordinator',
    summary: 'Find listings missing the fields a buyer will ask about.',
    needs: 'database_query',
    instruction:
      'Query this workspace listings for rows missing price, area, locality or RERA number. '
      + 'List at most five with the identifier and which fields are absent. If the listings '
      + 'table is empty, say that it is empty — that is a complete and correct answer. '
      + 'Never fill in a missing value.',
  },
  {
    id: 'showings.unconfirmed',
    role: 'Showing coordinator',
    summary: 'Check which viewings are still unconfirmed.',
    needs: 'google-calendar',
    instruction:
      'Read the calendar for viewings in the next three days that have no confirmed attendee. '
      + 'List them with time and property. If the calendar is not connected, say so and stop. '
      + 'Never invent a booked slot and never message an attendee.',
  },
  {
    id: 'research.watchlist',
    role: 'Research',
    summary: 'Read the watchlist pages and report what changed.',
    needs: 'web_extract',
    instruction:
      'Read each page on the research watchlist. Report only claims the retrieved text '
      + 'supports, each with the page it came from. Where two sources disagree, say so rather '
      + 'than choosing. If a page could not be read, name it. Never cite a page you did not read.',
  },
  {
    id: 'finance.outstanding',
    role: 'Finance',
    summary: 'Check what is owed and unpaid.',
    needs: 'razorpay',
    instruction:
      'Read outstanding payment links and their status. Report totals and anything overdue by '
      + 'more than seven days. If the payment provider is not connected, say so and stop. '
      + 'Never state an amount the provider did not return, and never send a reminder.',
  },
];

/** The duty for a role, or null when that role has none defined. */
export function dutyForRole(role: string): Duty | null {
  const wanted = String(role || '').trim().toLowerCase();
  return DUTIES.find((d) => d.role.toLowerCase() === wanted) ?? null;
}

/**
 * Is this tool usable right now, in this environment?
 *
 * Separate from "is the employee allowed to use it". An employee can hold a
 * tool the workspace cannot reach — that is the normal state of this product
 * today, with 61 of 65 tools waiting on a credential — and the difference
 * between "not permitted" and "not connected" is the difference between a
 * refusal and an outage. They must never be reported as the same thing.
 */
export function toolIsLiveToday(
  tool: string,
  env: Record<string, string | undefined> = process.env,
  liveOauthProviders: string[] = []
): boolean {
  const t = String(tool || '').toLowerCase();
  if (NEEDS_NO_CREDENTIAL.has(t)) return true;

  const keys = KEY_GATED[t];
  if (keys) return keys.some((k) => typeof env[k] === 'string' && env[k]!.trim().length > 0);

  // Everything else is OAuth: live only when this workspace holds a connection.
  return liveOauthProviders.map((p) => p.toLowerCase()).includes(t);
}

export type DutyBlockReason = 'no-duty' | 'not-permitted' | 'not-connected';

export interface DutyPlan {
  employeeId: string;
  employeeName: string;
  role: string;
  duty: Duty | null;
  runnable: boolean;
  /** Present when runnable is false. Never conflates permission with reach. */
  blockedBecause?: DutyBlockReason;
  /**
   * The allowlist the duty runs with: what it needs, and only if held.
   * Never the employee's full authority — see the header.
   */
  dutyAllowlist: string[];
}

/** Decide what one employee will do, and say plainly why not when it will not. */
export function planDuty(
  employee: { id: string; name: string; role: string; toolAllowlist: string[] },
  env: Record<string, string | undefined> = process.env,
  liveOauthProviders: string[] = []
): DutyPlan {
  const base = {
    employeeId: employee.id,
    employeeName: employee.name,
    role: employee.role,
    dutyAllowlist: [] as string[],
  };

  const duty = dutyForRole(employee.role);
  if (!duty) return { ...base, duty: null, runnable: false, blockedBecause: 'no-duty' };

  const held = (employee.toolAllowlist || []).map((t) => String(t).toLowerCase());
  if (!held.includes(duty.needs.toLowerCase())) {
    return { ...base, duty, runnable: false, blockedBecause: 'not-permitted' };
  }

  if (!toolIsLiveToday(duty.needs, env, liveOauthProviders)) {
    return { ...base, duty, runnable: false, blockedBecause: 'not-connected' };
  }

  return { ...base, duty, runnable: true, dutyAllowlist: [duty.needs] };
}

/** How to say a block out loud, for an operator rather than a log. */
export function explainBlock(plan: DutyPlan): string {
  switch (plan.blockedBecause) {
    case 'no-duty':
      return `${plan.employeeName} (${plan.role}) has no standing duty defined for this role.`;
    case 'not-permitted':
      return `${plan.employeeName} is not permitted ${plan.duty?.needs} — its duty needs it.`;
    case 'not-connected':
      return `${plan.employeeName} holds ${plan.duty?.needs}, but it is not connected in this workspace.`;
    default:
      return `${plan.employeeName} will run: ${plan.duty?.summary}`;
  }
}
