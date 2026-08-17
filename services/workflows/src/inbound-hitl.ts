/**
 * Workflow-safe HITL classifier (O7). Send/pay/sign inbound must wait on a
 * Temporal signal **before** side-effecting tools run. Greetings and read/draft
 * tools must not. Pure — no Node APIs.
 *
 * Called from WorkItemWorkflow before the agent child (user-message intent)
 * and after criticCheck as a reply-class safety net. Dashboard inbound-agent
 * Temporal-down fallback uses the same gate via `runInboundDirectFallback`
 * (do not duplicate these rules). Tests: inbound-hitl.test.ts.
 * Dashboard confirm-classes.ts is HTTP-only and not importable from workflows.
 */

export type InboundHitlClass = 'send' | 'pay' | 'sign';

export type InboundHitlDecision = {
  wait: boolean;
  classes: InboundHitlClass[];
};

const PAY_CLOSE_RE =
  /\b(marked as paid|payment received|i('ve| have) closed (the )?(charge|payment)|rent (is )?paid|charge closed|recorded (your )?payment)\b/i;
const USER_CLAIMED_PAY_RE = /\b(i('ve| have)?\s+paid|payment (sent|done|completed)|just paid)\b/i;
const SIGN_RE =
  /\b(please sign|sign (the|this) (agreement|contract|lease)|docusign|leegality|envelope (sent|created)|e-?sign)\b/i;
/** User asked to send email/quote — not “send me the details” and not pay/sign. */
const USER_SEND_INTENT_RE =
  /\b(email the (client|customer|prospect|buyer|tenant|owner)|(?:please )?email (them|her|him)|send (them |the client |the customer )?(an |the )?(email|quote|proposal)|mail the (client|customer)|send (an |the )?email)\b/i;
const USER_PAY_INTENT_RE =
  /\b(payment[- ]link|send a (payment|razorpay|stripe)|create a (charge|payout|payment link))\b/i;
const USER_SIGN_INTENT_RE = /\b((agreement|contract|lease) to sign)\b/i;

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/^mcp\.darex\./, '')
    .replace(/_/g, '-');
}

/**
 * Tool IDENTITY only — never its output.
 *
 * `step.result` used to be folded in here, and the risk matchers
 * (isPayRisk/isSendRisk/isSignRisk) look for bare tokens like `charge`,
 * `payout`, `payment-link`. Those are tool identifiers; run over free text they
 * match ordinary English. The result payload is exactly free text: when the
 * agent retrieved "outside Bengaluru a delivery charge of 1200 rupees applies"
 * or "orders can be cancelled free of charge within 48 hours", the word
 * `charge` in the RESEARCH tripped the payment gate, held the reply, and the
 * customer got an acknowledgement instead of the answer they asked for.
 *
 * A tool's identity is what tells you it had a side effect; its output is data
 * the agent read. Reading a policy that mentions a charge is not a payment.
 * Classifying on output also means the agent is penalised for doing better
 * research, which is precisely backwards.
 */
function blobOf(step: { tool?: string; toolUsed?: string; action?: string; result?: string }): string {
  return [step.toolUsed, step.tool, step.action].filter(Boolean).map((v) => normalizeToken(String(v))).join(' ');
}

function parseSteps(raw: unknown[] | undefined): Array<{
  tool?: string;
  toolUsed?: string;
  action?: string;
  result?: string;
}> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ tool?: string; toolUsed?: string; action?: string; result?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    out.push({
      tool: typeof rec.tool === 'string' ? rec.tool : undefined,
      toolUsed: typeof rec.toolUsed === 'string' ? rec.toolUsed : undefined,
      action: typeof rec.action === 'string' ? rec.action : undefined,
      result: typeof rec.result === 'string' ? rec.result : undefined,
    });
  }
  return out;
}

function isSendRisk(blob: string): boolean {
  if (/\bgmail-send\b/.test(blob) || /\bsend-email\b/.test(blob)) return true;
  if (/\b(microsoft-outlook|outlook).{0,40}send\b/.test(blob)) return true;
  if (/\bslack-send\b/.test(blob) || /\bsend-slack\b/.test(blob)) return true;
  if (/\bintercom-send\b/.test(blob) || /\bsend-intercom\b/.test(blob)) return true;
  if (/\btwilio-send\b/.test(blob) || /\bsend-sms\b/.test(blob)) return true;
  return false;
}

function isPayRisk(blob: string): boolean {
  if (/\b(razorpay|stripe)\b/.test(blob)) return true;
  if (/\b(payment-link|payout|charge)\b/.test(blob)) return true;
  return false;
}

function isSignRisk(blob: string): boolean {
  return /\b(docusign|leegality)\b/.test(blob) || /\b(envelope-sent|envelope-created)\b/.test(blob);
}

function classRank(klass: InboundHitlClass): number {
  switch (klass) {
    case 'pay':
      return 0;
    case 'sign':
      return 1;
    case 'send':
      return 2;
    default: {
      const _exhaustive: never = klass;
      return _exhaustive;
    }
  }
}

function uniqueClasses(classes: InboundHitlClass[]): InboundHitlClass[] {
  const seen = new Set<InboundHitlClass>();
  const ordered = [...classes].sort((a, b) => classRank(a) - classRank(b));
  const out: InboundHitlClass[] = [];
  for (const klass of ordered) {
    if (seen.has(klass)) continue;
    seen.add(klass);
    out.push(klass);
  }
  return out;
}

/**
 * Pause only for irreversible send/pay/sign. Channel-echo WhatsApp replies,
 * greetings, and read/draft tools (gmail_fetch, gmail_draft_email) do not wait.
 */
export function inboundRequiresHitlWait(input: {
  userMessage?: string;
  reply?: string;
  executedSteps?: unknown[];
  usedTools?: string[];
}): InboundHitlDecision {
  const classes: InboundHitlClass[] = [];
  const reply = String(input.reply || '');
  const userMessage = String(input.userMessage || '');
  const combined = `${userMessage}\n${reply}`;

  const steps = parseSteps(input.executedSteps);
  const toolBlobs = [
    ...steps.map((step) => blobOf(step)),
    ...(Array.isArray(input.usedTools) ? input.usedTools.map((t) => normalizeToken(t)) : []),
  ];

  for (const blob of toolBlobs) {
    if (!blob) continue;
    if (isPayRisk(blob)) classes.push('pay');
    if (isSignRisk(blob)) classes.push('sign');
    if (isSendRisk(blob)) classes.push('send');
  }

  if (SIGN_RE.test(reply)) classes.push('sign');
  if (PAY_CLOSE_RE.test(reply) || (USER_CLAIMED_PAY_RE.test(userMessage) && PAY_CLOSE_RE.test(reply))) {
    classes.push('pay');
  }
  if (USER_CLAIMED_PAY_RE.test(combined) && /\b(payment received|marked as paid|closed the charge)\b/i.test(reply)) {
    classes.push('pay');
  }

  // Pre-turn: classify from the inbound message so WorkItem can wait before
  // executeChild (PlanExecute pattern). Greetings / draft / “send me …” skip.
  // isPayRisk / isSendRisk match TOOL identifiers — "payout", "payment-link",
  // "charge" as in a Stripe charge object, "gmail-send". They must NEVER run
  // against a customer's natural language.
  //
  // Measured, not theorised: "Do you charge extra for installation?" matched
  // the bare word `charge`, was classified as a payment request, and the
  // workflow parked in waiting_approval for an operator signal that never came.
  // Four of twelve questions in the completion run hung exactly this way —
  // "can I cancel it", "how much do you charge", "is there a delivery charge",
  // "do you charge extra". Every one an ordinary pricing question; every one
  // answered with permanent silence. Nothing was logged because nothing
  // failed — the workflow was waiting, precisely as designed.
  //
  // Asking what something COSTS is a question. Only an instruction to move
  // money is an action. USER_PAY_INTENT_RE and USER_CLAIMED_PAY_RE already
  // encode that difference ("create a charge", "send a payment link",
  // "I've paid"), so the natural-language path uses those alone.
  if (USER_CLAIMED_PAY_RE.test(userMessage) || USER_PAY_INTENT_RE.test(userMessage)) {
    classes.push('pay');
  }
  // Signing keeps a keyword check: "docusign"/"leegality" named in a message is
  // an unambiguous signing intent with no innocent reading, unlike "charge".
  if (SIGN_RE.test(userMessage) || USER_SIGN_INTENT_RE.test(userMessage)) {
    classes.push('sign');
  }
  if (USER_SEND_INTENT_RE.test(userMessage)) {
    classes.push('send');
  }

  const unique = uniqueClasses(classes);
  return { wait: unique.length > 0, classes: unique };
}

export type InboundHitlGate = {
  wait: boolean;
  classes: InboundHitlClass[];
  /** Side-effecting send/pay/sign tools may run only when true. */
  allowSideEffectTools: boolean;
  /** Customer-facing action reply may be returned only when true. */
  allowCustomerReply: boolean;
  conversationNeedsAttention: boolean;
};

/**
 * PlanExecute-style gate: wait before tools. After reject, do not send/pay/sign
 * and do not return the customer-facing action reply. After approve, run them.
 */
export function resolveInboundHitlGate(input: {
  userMessage?: string;
  reply?: string;
  executedSteps?: unknown[];
  usedTools?: string[];
  decision?: 'approved' | 'rejected';
}): InboundHitlGate {
  const hitl = inboundRequiresHitlWait(input);
  if (!hitl.wait) {
    return {
      wait: false,
      classes: [],
      allowSideEffectTools: true,
      allowCustomerReply: true,
      conversationNeedsAttention: false,
    };
  }
  switch (input.decision) {
    case 'rejected':
      return {
        wait: false,
        classes: hitl.classes,
        allowSideEffectTools: false,
        allowCustomerReply: false,
        conversationNeedsAttention: true,
      };
    case 'approved':
      return {
        wait: false,
        classes: hitl.classes,
        allowSideEffectTools: true,
        allowCustomerReply: true,
        conversationNeedsAttention: false,
      };
    case undefined:
      return {
        wait: true,
        classes: hitl.classes,
        allowSideEffectTools: false,
        allowCustomerReply: false,
        conversationNeedsAttention: true,
      };
    default: {
      const _exhaustive: never = input.decision;
      return _exhaustive;
    }
  }
}

export type InboundDirectFallbackDecision =
  | { kind: 'execute' }
  | { kind: 'queue_hitl'; classes: InboundHitlClass[] };

/**
 * Temporal-down inbound fallback. Greetings / read / draft execute now.
 * Send / pay / sign must queue HITL and must not run side-effect tools.
 */
export function decideInboundDirectFallback(userMessage: string): InboundDirectFallbackDecision {
  const gate = resolveInboundHitlGate({ userMessage });
  if (gate.wait) {
    return { kind: 'queue_hitl', classes: gate.classes };
  }
  return { kind: 'execute' };
}

export type InboundDirectFallbackResult<T> =
  | { kind: 'executed'; result: T }
  | { kind: 'queued_hitl'; classes: InboundHitlClass[] };

/**
 * Shared execute-or-queue fork for Temporal-down inbound. `execute` is not
 * called for send/pay/sign, including when `queueHitl` throws.
 */
export async function runInboundDirectFallback<T>(
  userMessage: string,
  handlers: {
    execute: () => Promise<T>;
    queueHitl: (classes: InboundHitlClass[]) => Promise<void>;
  }
): Promise<InboundDirectFallbackResult<T>> {
  const decision = decideInboundDirectFallback(userMessage);
  switch (decision.kind) {
    case 'queue_hitl':
      await handlers.queueHitl(decision.classes);
      return { kind: 'queued_hitl', classes: decision.classes };
    case 'execute': {
      const result = await handlers.execute();
      return { kind: 'executed', result };
    }
    default: {
      const _exhaustive: never = decision;
      return _exhaustive;
    }
  }
}
