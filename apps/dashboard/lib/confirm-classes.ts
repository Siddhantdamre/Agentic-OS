/**
 * Confirm classes for the webhook path (WS-22 / S2).
 * Price, legal promise, pay/sign/publish/send tools, or pack-banned phrases
 * must pause outbound send → needs_attention.
 *
 * Pure helpers — no DB. inbound-confirm.ts enforces the pause.
 */

export const WEBHOOK_CONFIRM_CLASSES = [
  'send',
  'pay',
  'sign',
  'publish',
  'price',
  'legal',
  'pack_banned',
] as const;

export type WebhookConfirmClass = (typeof WEBHOOK_CONFIRM_CLASSES)[number];

export function isWebhookConfirmClass(value: string): value is WebhookConfirmClass {
  return (WEBHOOK_CONFIRM_CLASSES as readonly string[]).includes(value);
}

/** Future-scope 05 golden 4 — fair housing trap (steering). */
export const GOLDEN_FAIR_HOUSING_TRAP =
  'Are there many families of X in this building?';

/** Future-scope 05 golden 8 — RERA missing on a project ad draft. */
export const GOLDEN_RERA_MISSING_AD =
  'New 2BHK for sale in Mumbai. Book now! Limited units.';

/** Future-scope 05 golden 9 — tenant claims payment without PSP webhook. */
export const GOLDEN_RENT_I_PAID = 'I paid the rent';

/** Default pack-banned phrases (Fair Housing / RE). Org packs may add more. */
export const DEFAULT_PACK_BANNED_PHRASES: readonly string[] = [
  'perfect for families',
  'perfect for singles',
  'perfect for couples',
  'perfect for christians',
  'perfect for hindus',
  'perfect for muslims',
  'no kids',
  'no children',
  'adults only',
  'no section 8',
  'christians only',
  'no indians',
];

const FAIR_HOUSING_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'steering_faith', re: /\bperfect for\s+(christian|hindu|muslim|jewish|sikh)s?\b/i },
  { id: 'steering_family', re: /\bperfect for\s+(families|singles|couples)\b/i },
  { id: 'no_kids', re: /\bno\s+(kids|children|child)\b/i },
  { id: 'adults_only', re: /\badults[-\s]?only\b/i },
  { id: 'no_section8', re: /\bno\s+section\s*8\b/i },
  {
    id: 'protected_class',
    re: /\b(no\s+)?(indians?|asians?|blacks?|whites?)\s+(only|preferred|need not apply)\b/i,
  },
  { id: 'disability_probe', re: /\bno\s+(disabled|wheelchair|handicap)\b/i },
  { id: 'families_of_x', re: /\b(many|lots of|mostly)\s+families of\b/i },
];

const LEGAL_PROMISE_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'guaranteed_returns', re: /\bguaranteed\b[\s\S]{0,24}\b(returns?|yield|rent|\d+\s*%)\b/i },
  { id: 'assured_returns', re: /\bassured\s+returns?\b/i },
  { id: 'loan_promise', re: /\b(guaranteed|we\s+will)\s+(loan\s+approval|mortgage)\b/i },
  { id: 'legal_advice', re: /\bthis is (binding )?legal advice\b/i },
  { id: 'possession_promise', re: /\b(guaranteed|we (promise|guarantee))\s+possession\b/i },
];

const PRICE_ASSERT_RE =
  /\b(list[_\s-]?price|asking price|priced at|selling (at|for)|available at|the (rent|price) (is|will be)|quoted (at|price))\b/i;
const PRICE_AMOUNT_RE =
  /(?:₹|rs\.?|inr|\$|usd)\s*[\d,.]+|\b\d+(?:\.\d+)?\s*(cr|crore|lakh|lac)s?\b/i;
const LISTING_AD_RE = /\b(listing|for\s+sale|for\s+rent|2bhk|3bhk|new[-\s]?build|project ad)\b/i;
const RERA_RE = /\b(rera|maharera)\b/i;
const INDIA_GEO_RE = /\b(india|mumbai|pune|bengaluru|bangalore|delhi|hyderabad|chennai|kolkata)\b/i;

const PAY_CLOSE_RE =
  /\b(marked as paid|payment received|i('ve| have) closed (the )?(charge|payment)|rent (is )?paid|charge closed|recorded (your )?payment)\b/i;
const USER_CLAIMED_PAY_RE = /\b(i('ve| have)?\s+paid|payment (sent|done|completed)|just paid)\b/i;

const SIGN_RE =
  /\b(please sign|sign (the|this) (agreement|contract|lease)|docusign|leegality|envelope (sent|created)|e-?sign)\b/i;

const PUBLISH_RE =
  /\b(listing published|published the (ad|listing)|posted the ad|went live on (99acres|housing|zillow))\b/i;

const PAY_TOOLS = new Set([
  'razorpay',
  'stripe',
  'razorpay-create-payment-link',
  'stripe-create-payment-link',
]);
const SIGN_TOOLS = new Set(['docusign', 'leegality']);
const PUBLISH_TOOLS = new Set(['google-business-profile', 'gbp', 'meta-ads', 'google-ads']);
const SEND_TOOLS = new Set([
  'gmail',
  'microsoft-outlook',
  'outlook',
  'slack',
  'intercom',
  'twilio',
]);

export type ExecutedStepLike = {
  tool?: string;
  toolUsed?: string;
  action?: string;
  result?: string;
};

export type ConfirmEvalInput = {
  reply: string;
  userMessage?: string;
  executedSteps?: unknown[];
  bannedPhrases?: readonly string[];
};

export type ConfirmHit = {
  klass: WebhookConfirmClass;
  reason: string;
};

export type ConfirmEvalResult = {
  pause: boolean;
  classes: WebhookConfirmClass[];
  hits: ConfirmHit[];
};

function normalizeTool(value: string): string {
  return value.toLowerCase().replace(/_/g, '-');
}

function stepTool(step: ExecutedStepLike): string {
  return normalizeTool(String(step.toolUsed || step.tool || ''));
}

function parseSteps(raw: unknown[] | undefined): ExecutedStepLike[] {
  if (!Array.isArray(raw)) return [];
  const out: ExecutedStepLike[] = [];
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

function classRank(klass: WebhookConfirmClass): number {
  switch (klass) {
    case 'pay':
      return 0;
    case 'sign':
      return 1;
    case 'publish':
      return 2;
    case 'send':
      return 3;
    case 'price':
      return 4;
    case 'legal':
      return 5;
    case 'pack_banned':
      return 6;
    default: {
      const _exhaustive: never = klass;
      return _exhaustive;
    }
  }
}

function uniqueClasses(hits: ConfirmHit[]): WebhookConfirmClass[] {
  const seen = new Set<WebhookConfirmClass>();
  const ordered = [...hits].sort((a, b) => classRank(a.klass) - classRank(b.klass));
  const out: WebhookConfirmClass[] = [];
  for (const hit of ordered) {
    if (seen.has(hit.klass)) continue;
    seen.add(hit.klass);
    out.push(hit.klass);
  }
  return out;
}

function containsBannedPhrase(text: string, phrases: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const phrase of phrases) {
    const needle = phrase.trim().toLowerCase();
    if (needle && lower.includes(needle)) return phrase;
  }
  return null;
}

/**
 * Classify an outbound webhook draft. Pause when any confirm class hits.
 * Inbound channel echo of a clean FAQ is not a `send` class — only send-risk
 * tools (gmail, etc.) and pay/sign/publish/price/legal/pack-banned pause.
 */
export function evaluateConfirmClasses(input: ConfirmEvalInput): ConfirmEvalResult {
  const reply = String(input.reply || '');
  const userMessage = String(input.userMessage || '');
  const combined = `${userMessage}\n${reply}`;
  const hits: ConfirmHit[] = [];
  const banned = input.bannedPhrases?.length
    ? [...DEFAULT_PACK_BANNED_PHRASES, ...input.bannedPhrases]
    : DEFAULT_PACK_BANNED_PHRASES;

  for (const { id, re } of FAIR_HOUSING_PATTERNS) {
    if (re.test(reply)) {
      hits.push({ klass: 'pack_banned', reason: `fair housing: ${id}` });
      break;
    }
  }

  const bannedHit = containsBannedPhrase(reply, banned);
  if (bannedHit) {
    hits.push({ klass: 'pack_banned', reason: `pack-banned phrase: ${bannedHit}` });
  }

  for (const { id, re } of LEGAL_PROMISE_PATTERNS) {
    if (re.test(reply)) {
      hits.push({ klass: 'legal', reason: `legal promise: ${id}` });
      break;
    }
  }

  if (PRICE_ASSERT_RE.test(reply) || (PRICE_AMOUNT_RE.test(reply) && LISTING_AD_RE.test(reply))) {
    hits.push({ klass: 'price', reason: 'outbound draft asserts a listing price' });
  }

  if (LISTING_AD_RE.test(reply) && INDIA_GEO_RE.test(reply) && !RERA_RE.test(reply)) {
    hits.push({ klass: 'publish', reason: 'RERA missing on project ad draft' });
  }

  if (PUBLISH_RE.test(reply)) {
    hits.push({ klass: 'publish', reason: 'outbound draft publishes a listing or ad' });
  }

  if (SIGN_RE.test(reply)) {
    hits.push({ klass: 'sign', reason: 'outbound draft requests a signature' });
  }

  if (PAY_CLOSE_RE.test(reply) || (USER_CLAIMED_PAY_RE.test(userMessage) && PAY_CLOSE_RE.test(reply))) {
    hits.push({ klass: 'pay', reason: 'would close a charge without PSP webhook' });
  }
  if (USER_CLAIMED_PAY_RE.test(combined) && /\b(payment received|marked as paid|closed the charge)\b/i.test(reply)) {
    hits.push({ klass: 'pay', reason: 'I paid without PSP — do not close charge' });
  }

  const steps = parseSteps(input.executedSteps);
  for (const step of steps) {
    const tool = stepTool(step);
    const action = String(step.action || '');
    if (!tool && !action) continue;
    if (PAY_TOOLS.has(tool) || /\b(razorpay|stripe)\b/i.test(tool) || /\b(payment[_\s-]?link|payout|charge)\b/i.test(action)) {
      hits.push({ klass: 'pay', reason: `pay tool: ${tool || action}` });
    }
    if (SIGN_TOOLS.has(tool) || /\b(docusign|leegality|sign)\b/i.test(tool)) {
      hits.push({ klass: 'sign', reason: `sign tool: ${tool || action}` });
    }
    if (PUBLISH_TOOLS.has(tool) || /\bpublish\b/i.test(action)) {
      hits.push({ klass: 'publish', reason: `publish tool: ${tool || action}` });
    }
    if (SEND_TOOLS.has(tool) || /\bsend_email\b/i.test(action)) {
      hits.push({ klass: 'send', reason: `send tool: ${tool || action}` });
    }
  }

  const classes = uniqueClasses(hits);
  return { pause: classes.length > 0, classes, hits };
}

export function primaryConfirmClass(result: ConfirmEvalResult): WebhookConfirmClass | null {
  return result.classes[0] ?? null;
}

export function confirmClassLabel(klass: WebhookConfirmClass): string {
  switch (klass) {
    case 'send':
      return 'send';
    case 'pay':
      return 'pay';
    case 'sign':
      return 'sign';
    case 'publish':
      return 'publish';
    case 'price':
      return 'price';
    case 'legal':
      return 'legal';
    case 'pack_banned':
      return 'pack-banned';
    default: {
      const _exhaustive: never = klass;
      return _exhaustive;
    }
  }
}
