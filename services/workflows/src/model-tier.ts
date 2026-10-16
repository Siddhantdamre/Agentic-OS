/**
 * Which model should answer this turn?
 *
 * The rule is about people, not cost: where a wrong answer can cost someone money, a promise or a relationship
 * (payments, refunds, complaints, tax, legal, contracts) the strongest model answers; a plain lookup stays on the
 * cheap one. If the workspace's spend cap is used up, a money question steps down one level and says so, rather than
 * quietly getting a weaker answer.
 *
 * Routing is off unless DAREX_TIER_ROUTING=1. When on, the LiteLLM gateway candidate leads with a tier alias
 * (darex-standard / darex-deep, defined in infra/litellm/config.yaml); every other candidate stays as a fallback.
 */
export type Tier = 'fast' | 'standard' | 'deep';

export interface TierInput {
  message: string;
  hasAttachment?: boolean;
  /** False when the workspace has used its model budget for the period. */
  deepAllowed: boolean;
}
export interface TierChoice {
  tier: Tier;
  /** Said to the owner when the answer is weaker than the question deserved. */
  note?: string;
}
export interface TierCandidate {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

// Where a mistake hurts a person. English, Hinglish and Devanagari.
const HIGH_STAKES = new RegExp(
  '(?<![A-Za-z])(?:' + [
    'refund', 'chargeback', 'payment', 'invoice', 'overdue', 'outstanding', 'dues?\\b', 'gst', 'tax', 'tds', 'interest (?:rate|charge)',
    'legal', 'lawyer', 'court', 'legal notice', 'notice period', 'agreement', 'contract', 'lease', 'deposit', 'penalty', 'complain', 'threat',
    'harass', 'fraud', 'scam', 'discount', 'waive', 'compensat',
    'paisa', 'paise', 'baaki', 'bakaya', 'wapas', 'vapas', 'rashid', 'shikayat', 'dhokha',
    'पैसे', 'पैसा', 'भुगतान', 'रिफंड', 'वापस', 'बकाया', 'शिकायत', 'कानूनी', 'अनुबंध', 'किराया', 'जमा',
  ].join('|') + ')',
  'i',
);
const ANALYSIS = /\b(why|compare|comparison|forecast|trend|analy[sz]e|analysis|explain|plan|strategy|summari[sz]e|recommend|versus|vs)\b|kyun|kyon|क्यों|तुलना/i;
const LONG_CHARS = 600;

export function chooseTier(i: TierInput): TierChoice {
  const text = i.message ?? '';
  if (HIGH_STAKES.test(text)) {
    return i.deepAllowed
      ? { tier: 'deep' }
      : { tier: 'standard', note: 'This question involves money or a promise, and your AI budget for this period is used up, so a lighter model answered. Please double-check it before acting.' };
  }
  if (i.hasAttachment || text.length > LONG_CHARS || ANALYSIS.test(text)) return { tier: 'standard' };
  return { tier: 'fast' };
}

export function applyTier(candidates: TierCandidate[], tier: Tier, env: Record<string, string | undefined>): TierCandidate[] {
  if (env.DAREX_TIER_ROUTING !== '1' || tier === 'fast') return candidates;
  const idx = candidates.findIndex((c) => c.name === 'litellm');
  if (idx < 0) return candidates;
  const alias = tier === 'deep' ? env.DAREX_MODEL_DEEP || 'darex-deep' : env.DAREX_MODEL_STANDARD || 'darex-standard';
  const lead = { ...candidates[idx], model: alias };
  return [lead, ...candidates.filter((_, n) => n !== idx)];
}
