// Classifier for the Reasoning + Plan-Confirm-Execute flow.
//
// Strategy (per product decision):
//   - Prefer atomic-agent as a LOW-TOKEN classifier that returns a strict JSON
//     tag {"type":"SIMPLE"} / {"type":"COMPLEX"}. One tiny turn, fast.
//   - If the classifier call fails/times out, fall back to cheap heuristics.
//   - When uncertain, bias to SIMPLE (avoids over-triggering the plan flow).

const ATOMIC_AGENT_URL = process.env.ATOMIC_AGENT_URL || 'http://localhost:8787';
const ATOMIC_AGENT_API_KEY = process.env.ATOMIC_AGENT_API_KEY || 'darex-atomic-agent-dev-key';
const ATOMIC_AGENT_MODEL = process.env.ATOMIC_AGENT_MODEL || 'atomic-agent';

export interface ClassifyResult {
  type: 'simple' | 'complex';
  confidence: number;
  usedFallback: boolean;
  model?: string;
}

const COMPLEX_HINTS = new RegExp(
  [
    '\\b(book|schedule|calendar|invite|appointment|meeting|reserve)\\b',
    '\\b(send|draft|compose|dispatch|forward|reply to)\\b.*\\b(email|mail|gmail|message)\\b',
    '\\b(email|mail)\\b.*\\b(send|draft|dispatch|forward|reply)\\b',
    '\\b(create|update|edit|log|add|append)\\b',
    '\\b(drive|docs|sheets|spreadsheet|document|upload|share file)\\b',
    '\\b(extract\\s+otp|otp|verification code|attachment|pdf)\\b',
    '\\b(triage|classify\\s+(the\\s+)?inbox|inbox\\s+summary)\\b',
    '\\b(check\\s+availability|free\\s+slot|when\\s+is\\s+(everyone|the team)\\s+free)\\b',
    '\\b(ticket|lead|contact|crm|issue|deal)\\b',
    '\\b(analyze|report|metrics|roas|ctr|campaign)\\b',
    '\\b(whatsapp|slack|message)\\s.*\\b(send|notify)\\b',
    '\\b(find|search|read|fetch)\\b.*\\b(email|doc|file|spreadsheet|ticket)\\b',
  ].join('|'),
  'i'
);

const SIMPLE_HINTS = new RegExp(
  [
    '^\\s*(hi|hello|hey|yo|good\\s?(morning|afternoon|evening))\\b',
    '\\b(what\\s+is|what\\s+are|explain|define|how\\s+(do|does|can|would)|tell\\s+me|meaning of)\\b',
    '\\b(who\\s+are\\s+you|thanks|thank you|you\\s+are\\s+awesome|cool|nice)\\b',
    '\\b(just\\s+chatting|no\\s+tools|general\\s+question)\\b',
  ].join('|'),
  'i'
);

/**
 * Runs a tiny, non-streaming atomic-agent turn that responds with ONLY a JSON
 * tag. Uses a throwaway session so classification never pollutes the assistant.
 */
async function classifyWithAgent(prompt: string, orgId: string): Promise<'simple' | 'complex' | 'unknown'> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const systemPrompt = [
      'You are a strict router for a business AI assistant.',
      `Organisation org_id=${orgId}; never ask about it.`,
      'Classify the user request.',
      'Reply with ONLY a JSON object, no prose, no code fences.',
      'Use exactly {"type":"SIMPLE"} or {"type":"COMPLEX"}.',
      'SIMPLE = plain Q&A / explanation / greeting / knowledge-only. No tool execution, no record changes.',
      'COMPLEX = any request that should use connected tools (gmail, calendar, drive, docs, sheets, hubspot, zendesk, notion, github, ads, whatsapp, slack, stripe, sql) or requires multi-step work: read/triage inbox, draft/send email, OTP/attachment extraction, schedule/book, availability check, create/update/find records, upload/share/append files, analytics over data, or any action needing approval before running.',
      'When in doubt, choose SIMPLE.',
    ].join('\n');

    const res = await fetch(`${ATOMIC_AGENT_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ATOMIC_AGENT_API_KEY}`,
        'X-Atomic-Extensions': 'on',
      },
      body: JSON.stringify({
        model: ATOMIC_AGENT_MODEL,
        stream: false,
        max_tokens: 24,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `User request: ${prompt}` },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) return 'unknown';
    const data = await res.json();
    const content: string = data?.choices?.[0]?.message?.content || '';
    if (/COMPLEX/i.test(content)) return 'complex';
    if (/SIMPLE/i.test(content)) return 'simple';
    return 'unknown';
  } catch (err) {
    console.warn('[Classifier] atomic-agent call failed:', (err as Error)?.message);
    return 'unknown';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Primary classifier entry. Returns { type, confidence, usedFallback }.
 */
export async function classifyRequest(prompt: string, orgId: string): Promise<ClassifyResult> {
  const trimmed = (prompt || '').trim();
  if (trimmed.length === 0) return { type: 'simple', confidence: 1, usedFallback: true };

  const agentType = await classifyWithAgent(trimmed, orgId);
  if (agentType === 'complex') return { type: 'complex', confidence: 0.75, usedFallback: false, model: 'atomic-agent' };
  if (agentType === 'simple') return { type: 'simple', confidence: 0.7, usedFallback: false, model: 'atomic-agent' };

  // Fallback heuristics — bias to SIMPLE on any ambiguity.
  const complex = COMPLEX_HINTS.test(trimmed);
  const simple = SIMPLE_HINTS.test(trimmed);
  if (complex && !simple) return { type: 'complex', confidence: 0.6, usedFallback: true };
  return { type: 'simple', confidence: 0.5, usedFallback: true };
}