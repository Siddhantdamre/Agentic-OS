import type { RankedCandidate, WonAccountFeatures } from '@darex/shared-types';

/** Deterministic fallback when the LLM is unavailable — never blocks a card on it. */
export function heuristicWhyNow(candidate: Pick<RankedCandidate, 'activeSignals'>): string {
  const hiring = candidate.activeSignals.find((s) => s.type === 'hiring');
  const funding = candidate.activeSignals.find((s) => s.type === 'funding');
  const intent = candidate.activeSignals.find((s) => s.type === 'intent');
  return (
    [hiring?.summary, funding?.summary, intent?.summary].filter(Boolean).join(' · ') || 'Fresh public activity.'
  );
}

/**
 * GE-06 "Why Today?" Matchmaker — synthesizes a 2-sentence reason to reach
 * out today, grounded in the candidate's live signals and the ledger of
 * this org's own past closed-won accounts. Falls back to the deterministic
 * signal concatenation when no LiteLLM endpoint/key is configured, or on
 * any model failure — never blocks opportunity creation on the LLM call.
 */
export async function synthesizeWhyNow(
  candidate: Pick<RankedCandidate, 'companyName' | 'activeSignals'>,
  wonDeals: WonAccountFeatures[],
  timeoutMs = 10_000,
): Promise<string> {
  const fallback = heuristicWhyNow(candidate);

  const isProd = process.env.NODE_ENV === 'production';
  const rawBase = process.env.LITELLM_BASE_URL || (isProd ? '' : 'http://localhost:4000/v1');
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  if (!rawBase || !apiKey) return fallback;
  if (candidate.activeSignals.length === 0) return fallback;

  const baseUrl = rawBase.replace(/\/$/, '');
  const url = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  const model = process.env.LITELLM_CLASSIFY_MODEL || process.env.LITELLM_MODEL || 'atomic-agent';

  const signalLines = candidate.activeSignals.slice(0, 5).map((s) => `- (${s.type}) ${s.summary}`).join('\n');
  const wonLines = wonDeals
    .slice(0, 5)
    .map((w) => `- ${w.companyName}${w.industry ? ` (${w.industry})` : ''}`)
    .join('\n');

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
        temperature: 0.3,
        reasoning: { enabled: false },
        messages: [
          {
            role: 'system',
            content:
              'Write exactly 2 sentences explaining why reaching out to this prospect today makes sense. ' +
              'Reference the live buying signals and, where relevant, draw a concrete parallel to one of the ' +
              'past closed-won accounts listed. No preamble, no markdown, plain text only.',
          },
          {
            role: 'user',
            content:
              `Prospect: ${candidate.companyName}\n\nActive signals:\n${signalLines || 'none'}\n\n` +
              `Past closed-won accounts (the ledger):\n${wonLines || 'none'}`,
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (data.choices?.[0]?.message?.content || '').trim();
    return text || fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
