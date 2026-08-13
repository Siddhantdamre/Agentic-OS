/**
 * Pack compliance validators — code, not vibes. Known-bad drafts must fail tests.
 */

export interface DraftValidation {
  allow: boolean;
  policy: 'ok' | 'fair_housing' | 'rera' | 'legal_promise';
  violations: string[];
  reason: string;
}

export const KNOWN_BAD_FAIR_HOUSING_DRAFT =
  'This 2BHK is perfect for Christian families, no kids, adults only, no Section 8.';

export const KNOWN_BAD_RERA_AD =
  'New 2BHK for sale in Mumbai, possession guaranteed December. Book now.';

const FAIR_HOUSING: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'steering_faith', re: /\bperfect for\s+(christian|hindu|muslim|jewish|sikh)s?\b/i },
  { id: 'steering_family', re: /\bperfect for\s+(families|singles|couples)\b/i },
  { id: 'no_kids', re: /\bno\s+(kids|children|child)\b/i },
  { id: 'adults_only', re: /\badults[-\s]?only\b/i },
  { id: 'no_section8', re: /\bno\s+section\s*8\b/i },
];

const LEGAL_PROMISE: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: 'guaranteed_returns', re: /\bguaranteed\b[\s\S]{0,24}\b(returns?|yield|rent|\d+\s*%)\b/i },
  { id: 'assured_returns', re: /\bassured\s+returns?\b/i },
];

export function validateOutboundDraft(
  draft: string,
  intent: 'send' | 'publish' | 'sign'
): DraftValidation {
  switch (intent) {
    case 'send':
    case 'publish':
    case 'sign':
      break;
    default: {
      const _exhaustive: never = intent;
      return { allow: false, policy: 'ok', violations: [String(_exhaustive)], reason: 'unknown intent' };
    }
  }
  const text = (draft || '').trim();
  const violations: string[] = [];
  for (const { id, re } of FAIR_HOUSING) {
    if (re.test(text)) violations.push(id);
  }
  if (violations.length > 0) {
    return {
      allow: false,
      policy: 'fair_housing',
      violations,
      reason: 'blocked by policy: fair housing',
    };
  }
  for (const { id, re } of LEGAL_PROMISE) {
    if (re.test(text)) violations.push(id);
  }
  if (violations.length > 0) {
    return {
      allow: false,
      policy: 'legal_promise',
      violations,
      reason: 'blocked by policy: legal promise',
    };
  }
  const looksLikeInAd =
    intent === 'publish' &&
    /\b(for\s+sale|for\s+rent|2bhk|3bhk|listing)\b/i.test(text) &&
    /\b(mumbai|pune|bengaluru|bangalore|india|koramangala)\b/i.test(text);
  if (looksLikeInAd && !/\brera\b/i.test(text)) {
    return {
      allow: false,
      policy: 'rera',
      violations: ['rera_missing'],
      reason: 'blocked by policy: RERA missing',
    };
  }
  return { allow: true, policy: 'ok', violations: [], reason: 'heuristic pass' };
}
