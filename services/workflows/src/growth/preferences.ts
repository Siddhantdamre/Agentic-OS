import type { PreferenceRule } from '@darex/shared-types';

const FIELD_HINTS: Array<{ field: PreferenceRule['field']; re: RegExp }> = [
  { field: 'headcount', re: /\b(small|tiny|headcount|employees?|size)\b/i },
  { field: 'industry', re: /\b(industr|vertical|agency|saas|b2c|b2b)\b/i },
  { field: 'geo', re: /\b(geo|countr|region|outside|india|europe|us)\b/i },
  { field: 'title', re: /\b(title|intern|junior|role)\b/i },
];

export function heuristicRulesFromComment(comment: string): PreferenceRule[] {
  const text = comment.trim();
  if (!text) return [];
  const rules: PreferenceRule[] = [];
  const employees = text.match(/(\d+)\s*(employees?|people|headcount)/i);
  if (employees) {
    const n = Number(employees[1]);
    if (/less|under|below|smaller|too small/i.test(text)) {
      rules.push({ field: 'headcount', op: 'gte', value: n, source: text.slice(0, 160) });
    } else if (/more|over|above|larger|too big/i.test(text)) {
      rules.push({ field: 'headcount', op: 'lte', value: n, source: text.slice(0, 160) });
    }
  }
  if (/outside india|not india|india only/i.test(text)) {
    rules.push({ field: 'geo', op: 'in', value: ['india'], source: text.slice(0, 160) });
  }
  if (rules.length > 0) return rules;

  const hinted = FIELD_HINTS.find((h) => h.re.test(text));
  if (hinted?.field === 'industry' && /agency/i.test(text)) {
    return [{ field: 'industry', op: 'not_in', value: ['agency'], source: text.slice(0, 160) }];
  }
  return [];
}

/**
 * GE-10 Voice & Style Learner — one-click reject reasons from
 * OpportunityCard.tsx map directly onto a PreferenceRule, distilled
 * synchronously (no LLM round-trip needed for a structured reason code).
 * `wrong_timing` and `just_not_now` never produce a hard filter rule —
 * timing isn't one of PreferenceRule's fields, so those stay a one-off
 * suppression instead of silently blocking a company/industry forever.
 */
export function ruleFromRejection(
  reason: 'wrong_fit' | 'wrong_timing' | 'wrong_channel' | 'just_not_now',
  card: { industry?: string; geo?: string; companyName?: string },
): PreferenceRule | null {
  if (reason !== 'wrong_fit') return null;
  const source = card.companyName ? `Rejected as wrong fit: ${card.companyName}` : 'Rejected as wrong fit';
  if (card.industry) {
    return { field: 'industry', op: 'not_in', value: [card.industry.toLowerCase()], source };
  }
  if (card.geo) {
    return { field: 'geo', op: 'not_in', value: [card.geo.toLowerCase()], source };
  }
  return null;
}

export function mergePreferenceRules(existing: PreferenceRule[], incoming: PreferenceRule[]): PreferenceRule[] {
  const out = [...existing];
  for (const rule of incoming) {
    const dup = out.some(
      (r) => r.field === rule.field && r.op === rule.op && JSON.stringify(r.value) === JSON.stringify(rule.value),
    );
    if (!dup) out.push(rule);
  }
  return out.slice(0, 40);
}

export function parseLlmRules(raw: string): PreferenceRule[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PreferenceRule[] = [];
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const rec = row as Record<string, unknown>;
      const field = rec.field;
      const op = rec.op;
      if (field !== 'headcount' && field !== 'industry' && field !== 'geo' && field !== 'title') continue;
      if (op !== 'gte' && op !== 'lte' && op !== 'in' && op !== 'not_in') continue;
      if (rec.value === undefined) continue;
      out.push({
        field,
        op,
        value: rec.value as PreferenceRule['value'],
        source: typeof rec.source === 'string' ? rec.source : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function distillRulesViaLlm(comments: string[], timeoutMs = 12_000): Promise<PreferenceRule[]> {
  const usable = comments.map((c) => c.trim()).filter((c) => c.length > 0).slice(0, 15);
  if (usable.length === 0) return [];

  const isProd = process.env.NODE_ENV === 'production';
  const rawBase = process.env.LITELLM_BASE_URL || (isProd ? '' : 'http://localhost:4000/v1');
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  if (!rawBase || !apiKey) return [];

  const baseUrl = rawBase.replace(/\/$/, '');
  const url = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  const model = process.env.LITELLM_CLASSIFY_MODEL || process.env.LITELLM_MODEL || process.env.TRUEFORGE_MODEL || 'darex-default';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        reasoning: { enabled: false },
        messages: [
          {
            role: 'system',
            content:
              'Distill owner rejection comments into JSON preference rules. Return only a JSON array of objects with field (headcount|industry|geo|title), op (gte|lte|in|not_in), value, and optional source. No prose.',
          },
          { role: 'user', content: usable.map((c, i) => `${i + 1}. ${c.slice(0, 240)}`).join('\n') },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return parseLlmRules(data.choices?.[0]?.message?.content || '');
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
