/**
 * Critic gate (E3): LiteLLM JSON + deterministic policy before send/publish/sign.
 * Known-bad fair-housing drafts are blocked even when LiteLLM is down.
 */
import { llmChat } from '../llm/gateway.js';

export type CriticIntent = 'send' | 'publish' | 'sign';

export type CriticPolicy =
  | 'fair_housing'
  | 'legal_promise'
  | 'rera'
  | 'ok'
  | 'model'
  // Set by the reply gate, never by this file's checks: the draft asserted a
  // figure, date or reference the retrieved evidence does not support.
  // Revisable — the fix is to drop the number or look it up. See grounding.ts.
  | 'grounding';

export interface CriticCheckParams {
  orgId: string;
  draft: string;
  intent: CriticIntent;
  businessKey?: string;
}

export interface CriticCheckResult {
  allow: boolean;
  policy: CriticPolicy;
  reason: string;
  violations: string[];
  source: 'heuristic' | 'litellm';
}

export const KNOWN_BAD_FAIR_HOUSING_DRAFT =
  'This 2BHK is perfect for Christian families, no kids, adults only, no Section 8.';

const FAIR_HOUSING_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'steering_faith', re: /\bperfect for\s+(christian|hindu|muslim|jewish|sikh)s?\b/i },
  { id: 'steering_family', re: /\bperfect for\s+(families|singles|couples)\b/i },
  { id: 'no_kids', re: /\bno\s+(kids|children|child)\b/i },
  { id: 'adults_only', re: /\badults[-\s]?only\b/i },
  { id: 'no_section8', re: /\bno\s+section\s*8\b/i },
  { id: 'protected_class', re: /\b(no\s+)?(indians?|asians?|blacks?|whites?)\s+(only|preferred|need not apply)\b/i },
  { id: 'disability_probe', re: /\bno\s+(disabled|wheelchair|handicap)\b/i },
];

const LEGAL_PROMISE_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'guaranteed_returns', re: /\bguaranteed\b[\s\S]{0,24}\b(returns?|yield|rent|\d+\s*%)\b/i },
  { id: 'assured_returns', re: /\bassured\s+returns?\b/i },
  { id: 'loan_promise', re: /\b(guaranteed|we\s+will)\s+(loan\s+approval|mortgage)\b/i },
];

const RERA_MISSING_RE = /\b(rera|mahaRERA)\b/i;
const LISTING_AD_RE = /\b(listing|for\s+sale|for\s+rent|2bhk|3bhk)\b/i;

function needsCritic(intent: CriticIntent): boolean {
  switch (intent) {
    case 'send':
    case 'publish':
    case 'sign':
      return true;
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

export function evaluateCriticDraft(draft: string, intent: CriticIntent): CriticCheckResult {
  if (!needsCritic(intent)) {
    return { allow: true, policy: 'ok', reason: 'intent skipped', violations: [], source: 'heuristic' };
  }
  const text = (draft || '').trim();
  if (!text) {
    return { allow: true, policy: 'ok', reason: 'empty draft', violations: [], source: 'heuristic' };
  }

  const violations: string[] = [];
  for (const { id, re } of FAIR_HOUSING_PATTERNS) {
    if (re.test(text)) violations.push(id);
  }
  if (violations.length > 0) {
    return {
      allow: false,
      policy: 'fair_housing',
      reason: 'blocked by policy: fair housing',
      violations,
      source: 'heuristic',
    };
  }

  for (const { id, re } of LEGAL_PROMISE_PATTERNS) {
    if (re.test(text)) violations.push(id);
  }
  if (violations.length > 0) {
    return {
      allow: false,
      policy: 'legal_promise',
      reason: 'blocked by policy: legal promise',
      violations,
      source: 'heuristic',
    };
  }

  if (intent === 'publish' && LISTING_AD_RE.test(text) && !RERA_MISSING_RE.test(text) && /\bindia|mumbai|pune|bengaluru\b/i.test(text)) {
    return {
      allow: false,
      policy: 'rera',
      reason: 'blocked by policy: RERA missing',
      violations: ['rera_missing'],
      source: 'heuristic',
    };
  }

  return { allow: true, policy: 'ok', reason: 'heuristic pass', violations: [], source: 'heuristic' };
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] || trimmed).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

interface CriticModelJson {
  allow?: boolean;
  policy?: string;
  reason?: string;
  violations?: unknown;
}

function parsePolicy(value: string, allow: boolean): CriticPolicy {
  switch (value) {
    case 'fair_housing':
    case 'legal_promise':
    case 'rera':
    case 'ok':
    case 'model':
      return value;
    case '':
      return allow ? 'ok' : 'model';
    default:
      return allow ? 'ok' : 'model';
  }
}

function parseCriticJson(raw: string): CriticCheckResult | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as CriticModelJson;
    const allow = parsed.allow !== false;
    const violations = Array.isArray(parsed.violations)
      ? parsed.violations.filter((v): v is string => typeof v === 'string')
      : [];
    const policy = parsePolicy(String(parsed.policy || '').toLowerCase(), allow);
    return {
      allow,
      policy,
      reason: allow ? String(parsed.reason || 'model pass') : String(parsed.reason || 'blocked by policy: model'),
      violations,
      source: 'litellm',
    };
  } catch {
    return null;
  }
}

async function criticWithLiteLLM(draft: string, intent: CriticIntent, orgId?: string): Promise<CriticCheckResult | null> {
  // Through the gateway, which resolves the model from the WORKSPACE'S BUDGET
  // rather than from LITELLM_MODEL. This call used to read that env var
  // directly, so an over-budget tenant had its agent turn degraded to the free
  // tier and then paid full price for the critic on the very next line: the
  // gate fired and the spending carried on. See llm/gateway.ts.
  if (!orgId) return null;
  const res = await llmChat({
    orgId,
    purpose: 'critic',
    maxTokens: 200,
    temperature: 0,
    timeoutMs: 12_000,
    messages: [
      {
        role: 'system',
        content: [
          'You are a compliance critic for outbound business messages.',
          'Reply with ONLY JSON: {"allow":true|false,"policy":"ok"|"fair_housing"|"legal_promise"|"rera"|"model","reason":"...","violations":[]}',
          'Block fair housing steering (protected class, no kids, adults only, no Section 8, faith/family targeting).',
          'Block guaranteed returns and invented legal promises.',
          'Do not invent facts. Begin with the JSON object.',
        ].join(' '),
      },
      { role: 'user', content: `intent=${intent}\n---\n${draft.slice(0, 4000)}` },
    ],
  });
  // No answer means the heuristics stand alone, exactly as before. The critic
  // can only ever TIGHTEN a verdict, so losing it forfeits a chance to block
  // and never creates a chance to allow.
  if (res.error || !res.content) return null;
  return parseCriticJson(res.content);
}

/**
 * Heuristics always run. LiteLLM JSON can only tighten (never override a block).
 */
export async function criticCheck(params: CriticCheckParams): Promise<CriticCheckResult> {
  const heuristic = evaluateCriticDraft(params.draft, params.intent);
  if (!heuristic.allow) return heuristic;

  const modeled = await criticWithLiteLLM(params.draft, params.intent, params.orgId);
  if (modeled && !modeled.allow) return modeled;
  return heuristic;
}
