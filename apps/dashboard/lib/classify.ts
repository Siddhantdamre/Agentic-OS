// Classifier for the Reasoning + Plan-Confirm-Execute flow.
//
// Strategy (per product decision):
//   - Prefer LiteLLM as a LOW-TOKEN classifier that returns a strict JSON
//     tag {"type":"SIMPLE"} / {"type":"COMPLEX"}. One tiny turn, fast.
//   - If the classifier call fails/times out, fall back to cheap heuristics.
//   - When uncertain, bias to SIMPLE (avoids over-triggering the plan flow).

import { chatCompletion } from './litellm-client';

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
 * Runs a tiny, non-streaming LiteLLM turn that responds with ONLY a JSON tag.
 * The deepseek reasoning model burns small budgets in `reasoning_content`, so
 * we allow a modest completion budget and check the final content.
 */
async function classifyWithAgent(prompt: string, orgId: string): Promise<'simple' | 'complex' | 'unknown'> {
  try {
    const systemPrompt = [
      'You are a strict router for a business AI assistant.',
      `Organisation org_id=${orgId}; never ask about it.`,
      'Classify the user request.',
      'Reply with ONLY a JSON object, no prose, no code fences, no preamble.',
      'Use exactly {"type":"SIMPLE"} or {"type":"COMPLEX"}.',
      'SIMPLE = plain Q&A / explanation / greeting / knowledge-only. No tool execution, no record changes.',
      'COMPLEX = any request that should use connected tools (gmail, calendar, drive, docs, sheets, hubspot, zendesk, notion, github, ads, whatsapp, slack, stripe, sql) or requires multi-step work: read/triage inbox, draft/send email, OTP/attachment extraction, schedule/book, availability check, create/update/find records, upload/share/append files, analytics over data, or any action needing approval before running.',
      'When in doubt, choose SIMPLE.',
      'Begin your reply with the JSON object directly.',
    ].join('\n');

    const content = await chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `User request: ${prompt}` },
      ],
      { maxTokens: 300, temperature: 0, timeoutMs: 20000 }
    );
    if (/COMPLEX/i.test(content)) return 'complex';
    if (/SIMPLE/i.test(content)) return 'simple';
    return 'unknown';
  } catch (err) {
    console.warn('[Classifier] LiteLLM call failed:', (err as Error)?.message);
    return 'unknown';
  }
}

/**
 * Primary classifier entry. Returns { type, confidence, usedFallback }.
 */
export async function classifyRequest(prompt: string, orgId: string): Promise<ClassifyResult> {
  const trimmed = (prompt || '').trim();
  if (trimmed.length === 0) return { type: 'simple', confidence: 1, usedFallback: true };

  // 1. Fast-path heuristics: Check simple hints first.
  // If a request clearly matches simple patterns (greetings, simple Q&A) and NOT complex action verbs,
  // bypass the LLM entirely for a 0ms response time.
  const complex = COMPLEX_HINTS.test(trimmed);
  const simple = SIMPLE_HINTS.test(trimmed);

  if (simple && !complex) {
    return { type: 'simple', confidence: 0.9, usedFallback: true };
  }

  if (complex && !simple && trimmed.length < 150) {
    // If it's short and explicitly uses action words (like "send email to..."), 
    // it's highly likely to be complex. Skip LLM.
    return { type: 'complex', confidence: 0.85, usedFallback: true };
  }

  // 2. Slow-path: If ambiguous, ask the LLM router.
  const agentType = await classifyWithAgent(trimmed, orgId);
  if (agentType === 'complex') return { type: 'complex', confidence: 0.75, usedFallback: false, model: 'atomic-agent' };
  if (agentType === 'simple') return { type: 'simple', confidence: 0.7, usedFallback: false, model: 'atomic-agent' };

  // 3. Fallback if LLM fails: bias to SIMPLE on any remaining ambiguity to prevent getting stuck.
  if (complex) return { type: 'complex', confidence: 0.6, usedFallback: true };
  return { type: 'simple', confidence: 0.5, usedFallback: true };
}