/**
 * WHAT AN AI EMPLOYEE MAY ACTUALLY DO.
 *
 * Measured before this file existed: 56 AI employees across the deployment,
 * 51 "support" and 5 "sales", and every single one of them carried the same
 * tool_allowlist — `{database_query}`, a read. The roles differed in persona
 * text and in nothing else. An org chart where every job has identical
 * permissions is not an org chart.
 *
 * This module is the missing middle. tools/risk.ts already defines the risk
 * classes and says which need a human — but its own header admits it is
 * "metadata only", and nothing anywhere mapped a TOOL to a RISK, so the
 * taxonomy had no subjects. And tool-executor.ts enforces an allowlist, but
 * had two holes that made the enforcement much weaker than it looks.
 *
 * ── HOLE 1: A NARROW GRANT CONFERRED THE BROAD ONE ────────────────────────
 *
 * The original match was:
 *
 *     tool.startsWith(a + '-') || a.startsWith(tool + '-')
 *
 * The second clause runs backwards. Reproduced against the shipped code:
 *
 *     granted ['razorpay-refund-status']  ->  may call 'razorpay'  : TRUE
 *
 * Give an employee permission to check a refund's status, and it may call the
 * entire payments provider, payouts included. Permission must flow DOWNWARD
 * only: holding `razorpay` implies `razorpay-refund`, and holding
 * `razorpay-refund` implies nothing about `razorpay`.
 *
 * ── HOLE 2: EVERY ROLE INHERITED EVERY OTHER ROLE'S HANDS ─────────────────
 *
 * When a caller does not pass an allowlist, tool-executor falls back to the
 * union of ALL active employees' allowlists. So the moment one employee in the
 * org is given `razorpay`, the support bot can charge cards too. The
 * per-employee column is read and then unioned away.
 *
 * The union is a reasonable answer to "does this ORG own this tool". It is the
 * wrong answer to "may THIS EMPLOYEE use it", and it was being used for both.
 */
import type { ToolRisk } from './risk.js';
import { confirmForRisk } from './risk.js';

/** Lower-case, hyphenated. `database_query` and `Database-Query` are one key. */
export function normalizeToolKey(value: string): string {
  return String(value || '').toLowerCase().trim().replace(/_/g, '-');
}

/**
 * What each provider can do to the world.
 *
 * Keyed on the providers that actually exist in services/workflows/src/tools,
 * not on an imagined catalogue. The class is the WORST thing the provider can
 * do, because an allowlist entry grants the whole provider unless a narrower
 * key is granted: `razorpay` is 'pay' even though most of its endpoints only
 * read, because holding `razorpay` means holding the payout endpoint too.
 */
const PROVIDER_RISK: Record<string, ToolRisk> = {
  // Money. Never autonomous, at any trust level.
  razorpay: 'pay',
  stripe: 'pay',
  quickbooks: 'pay',

  // Legally binding.
  docusign: 'sign',
  leegality: 'sign',

  // Reaches a human being who is not the operator.
  gmail: 'send',
  whatsapp: 'send',
  twilio: 'send',
  slack: 'send',
  'google-chat': 'send',
  'microsoft-outlook': 'send',
  intercom: 'send',
  zendesk: 'send',

  // Visible to the public, and hard to unsay.
  'google-business-profile': 'publish',
  'meta-ads': 'publish',
  'google-ads': 'publish',
  shopify: 'publish',

  // Changes somebody else's records, but recoverable.
  hubspot: 'draft',
  salesforce: 'draft',
  zoho: 'draft',
  notion: 'draft',
  'google-calendar': 'draft',
  'microsoft-calendar': 'draft',
  'google-meet': 'draft',
  'google-tasks': 'draft',
  'google-docs': 'draft',
  'google-sheets': 'draft',
  'google-slides': 'draft',
  'google-forms': 'draft',
  'google-contacts': 'draft',
  'google-drive': 'draft',
  github: 'draft',

  // Reads.
  'web-search': 'read',
  'web-extract': 'read',
  'database-query': 'read',
  metrics: 'read',
  maps: 'read',
  'google-analytics': 'read',
  'google-search-console': 'read',
  realestate: 'read',

  // Executes code and touches the filesystem. Not a read by any reading, even
  // sandboxed — see ALWAYS_ALLOWED note in the deployment checks.
  sandbox: 'delete',
  'file-ops': 'delete',
  'google-cloud': 'delete',
};

/**
 * An action can be SAFER than its provider, never more dangerous.
 *
 * Reading a refund's status through the payments provider is a read. But the
 * downgrade only applies when the action is explicitly named — an unknown
 * action on a 'pay' provider stays 'pay', because guessing safety from a verb
 * nobody has classified is how a payout gets sent unattended.
 */
const SAFE_ACTIONS = new Set([
  'get', 'list', 'read', 'search', 'fetch', 'status', 'lookup', 'find', 'query', 'describe',
]);

/** The risk of one concrete call. Unknown providers are treated as dangerous. */
export function riskOf(tool: string, action?: string): ToolRisk {
  const key = normalizeToolKey(tool);
  // Longest declared prefix wins, so `razorpay-refund` inherits from `razorpay`
  // rather than falling through to the unknown-tool default.
  let base: ToolRisk | undefined = PROVIDER_RISK[key];
  if (!base) {
    let bestLen = -1;
    for (const [k, v] of Object.entries(PROVIDER_RISK)) {
      if (key.startsWith(`${k}-`) && k.length > bestLen) { base = v; bestLen = k.length; }
    }
  }
  // A tool nobody has classified is NOT assumed safe. An unknown key is the
  // one case where being wrong is unrecoverable, so it takes the strictest
  // class that still permits execution behind a human.
  if (!base) return 'send';

  if (action) {
    const a = normalizeToolKey(action).split('-')[0] || '';
    if (SAFE_ACTIONS.has(a) && base !== 'read') return 'read';
  }
  return base;
}

/**
 * Does this call need a human before it happens?
 *
 * Delegates to confirmForRisk so there is exactly one definition of
 * "irreversible" in the codebase, and this cannot drift from the table the
 * approval gate uses.
 */
export function needsHuman(tool: string, action?: string): boolean {
  return confirmForRisk(riskOf(tool, action));
}

/**
 * Is this tool granted by this allowlist?
 *
 * Permission flows DOWNWARD ONLY. See HOLE 1 above: the shipped version also
 * matched upward, so a narrow grant conferred the broad provider.
 */
export function isToolGranted(tool: string, allowlist: readonly string[]): boolean {
  const want = normalizeToolKey(tool);
  if (!want) return false;
  for (const raw of allowlist) {
    const held = normalizeToolKey(raw);
    if (!held) continue;
    if (held === want) return true;
    // Holding a provider grants everything under it.
    if (want.startsWith(`${held}-`)) return true;
    // Deliberately NOT the reverse.
  }
  return false;
}

/**
 * The hands each role gets by default.
 *
 * A starting point an owner can edit, not a ceiling — but a starting point
 * that differs, which is the entire point. Note that no role is given a 'pay'
 * or 'sign' tool by default: those are granted deliberately, per employee, by
 * a person who understands what they are handing over.
 */
export const ROLE_HANDS: Record<string, string[]> = {
  support: [
    'database-query', 'web-search', 'metrics',
    'gmail', 'whatsapp',           // answer the customer
    'zendesk', 'intercom',         // keep the ticket straight
  ],
  sales: [
    'database-query', 'web-search', 'metrics', 'maps', 'realestate',
    'gmail', 'whatsapp',
    'google-calendar', 'google-meet',   // book the viewing
    'hubspot', 'salesforce',            // record the lead
  ],
  collections: [
    'database-query', 'metrics',
    'gmail', 'whatsapp',
    'quickbooks',                  // see what is owed
    // razorpay / stripe are NOT here. Sending a payment link is a 'pay' tool
    // and is granted per employee, by a person, on purpose.
  ],
  operations: [
    'database-query', 'web-search', 'metrics',
    'google-sheets', 'google-docs', 'google-drive', 'google-tasks',
    'slack', 'notion',
  ],
  analyst: [
    'database-query', 'metrics', 'web-search', 'web-extract',
    'google-analytics', 'google-search-console', 'google-sheets',
  ],
};

export interface ToolDecision {
  allowed: boolean;
  needsApproval: boolean;
  risk: ToolRisk;
  reason: string;
}

/**
 * The whole decision for one tool call, in one place.
 *
 * `autonomyLevel` comes from the earned-autonomy ledger: 0 asks about
 * everything, higher levels are trusted with more. Money and signatures are
 * excluded from that progression on purpose — an agent does not earn the right
 * to move money by answering questions well, and migration 034's own tests
 * assert that money never stops asking.
 */
export function decideToolCall(params: {
  tool: string;
  action?: string;
  allowlist: readonly string[];
  autonomyLevel?: number;
}): ToolDecision {
  const risk = riskOf(params.tool, params.action);
  const key = normalizeToolKey(params.tool);

  if (!isToolGranted(params.tool, params.allowlist)) {
    return {
      allowed: false,
      needsApproval: false,
      risk,
      reason: `This employee does not have ${key}.`,
    };
  }

  if (risk === 'pay' || risk === 'sign') {
    return {
      allowed: true,
      needsApproval: true,
      risk,
      reason: `${key} moves money or signs something. A person approves this every time, whatever the agent has earned.`,
    };
  }

  if (!confirmForRisk(risk)) {
    return { allowed: true, needsApproval: false, risk, reason: `${key} is ${risk}.` };
  }

  // Reversible-but-outward actions: earned autonomy applies.
  const level = Number.isFinite(params.autonomyLevel) ? Number(params.autonomyLevel) : 0;
  const needsApproval = level < 2;
  return {
    allowed: true,
    needsApproval,
    risk,
    reason: needsApproval
      ? `${key} reaches someone outside the business, and this employee has not yet earned the right to do that unsupervised.`
      : `${key} is ${risk}, and this employee has earned the right to do it unsupervised.`,
  };
}
