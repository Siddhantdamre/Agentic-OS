// Classifier for the Reasoning + Plan-Confirm-Execute flow.
//
// Strategy (per product decision):
//   - Prefer LiteLLM as a LOW-TOKEN classifier that returns a strict JSON
//     tag {"type":"SIMPLE"} / {"type":"COMPLEX"} / optional playbook id.
//   - If the classifier call fails/times out, fall back to cheap heuristics.
//   - When uncertain, bias to SIMPLE (avoids over-triggering the plan flow).
//   - Named playbooks (O6) skip free-form plan generation at high confidence.
//     Greetings never match a playbook — "hi" must not spawn a crew.

import { chatCompletion } from './litellm-client';
import type { ClassifyResult, ClassifyType } from '@darex/shared-types';
import { getPlaybook, matchPlaybook, PLAYBOOK_IDS, PLAYBOOK_MATCH_THRESHOLD } from './playbook-matcher';
import { DAILY_BRIEF_RE } from '@darex/workflows/dist/route-employee';

export type { ClassifyResult, ClassifyType };

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
    '\\b(google\\s+analytics|ga4|search\\s+console|business\\s+profile|google\\s+chat|google\\s+meet|google\\s+cloud)\\b',
    '\\b(whatsapp|slack|message)\\s.*\\b(send|notify)\\b',
    '\\b(find|search|read|fetch)\\b.*\\b(email|doc|file|spreadsheet|ticket)\\b',
    '\\b(then|after that|and then|multi-?step|workflow|automat)\\b',
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

type AgentClassify = 'simple' | 'complex' | 'unknown';

function parseClassifierJson(content: string): { type: AgentClassify; playbookId?: string } {
  const cleaned = content.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { type?: unknown; playbook?: unknown };
      const rawType = typeof parsed.type === 'string' ? parsed.type.trim().toUpperCase() : '';
      const rawPlaybook = typeof parsed.playbook === 'string' ? parsed.playbook.trim() : undefined;
      const playbookHit = rawPlaybook ? PLAYBOOK_IDS.find((id) => id === rawPlaybook) : undefined;
      const playbookId = playbookHit && getPlaybook(playbookHit) ? playbookHit : undefined;
      if (rawType === 'COMPLEX') return { type: 'complex', playbookId };
      if (rawType === 'SIMPLE') return { type: 'simple' };
    } catch {
      // JSON parse failed, proceed to disciplined fallback
    }
  }

  // Look specifically for key-value pair "type": "COMPLEX" or "type": "SIMPLE"
  const typeMatch = content.match(/"type"\s*:\s*"(COMPLEX|SIMPLE)"/i);
  const playbookHit = PLAYBOOK_IDS.find((id) => content.includes(`"${id}"`) || content.includes(id));
  const playbookId = playbookHit && getPlaybook(playbookHit) ? playbookHit : undefined;
  if (typeMatch) {
    const matchedType = typeMatch[1].toUpperCase();
    if (matchedType === 'COMPLEX') return { type: 'complex', playbookId };
    if (matchedType === 'SIMPLE') return { type: 'simple' };
  }

  if (/\bCOMPLEX\b/i.test(content) && !/\bSIMPLE\b/i.test(content)) return { type: 'complex', playbookId };
  if (/\bSIMPLE\b/i.test(content) && !/\bCOMPLEX\b/i.test(content)) return { type: 'simple' };
  return { type: 'unknown', playbookId };
}

async function classifyWithAgent(
  prompt: string,
  orgId: string
): Promise<{ type: AgentClassify; playbookId?: string }> {
  try {
    const systemPrompt = [
      'You are a strict router for a business AI assistant.',
      `Organisation org_id=${orgId}; never ask about it.`,
      'Classify the user request.',
      'Reply with ONLY a JSON object, no prose, no code fences, no preamble.',
      'Use {"type":"SIMPLE"} or {"type":"COMPLEX"} or {"type":"COMPLEX","playbook":"<id>"}.',
      `Known playbooks: ${PLAYBOOK_IDS.join(', ')}.`,
      'SIMPLE = plain Q&A / explanation / greeting / knowledge-only. No tool execution, no record changes.',
      'Greetings like hi/hello/hey are SIMPLE. Never attach a playbook to a greeting. Never spawn multiple agents.',
      'COMPLEX = any request that should use connected tools or requires multi-step work.',
      'When a named playbook clearly fits, include its id. When in doubt, choose SIMPLE and omit playbook.',
      'Begin your reply with the JSON object directly.',
    ].join('\n');

    const content = await chatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `User request: ${prompt}` },
      ],
      { maxTokens: 300, temperature: 0, timeoutMs: 20000, orgId }
    );
    return parseClassifierJson(content);
  } catch (err) {
    console.warn('[Classifier] LiteLLM call failed:', (err as Error)?.message);
    return { type: 'unknown' };
  }
}

/**
 * Primary classifier entry. Returns { type, confidence, usedFallback, playbookId? }.
 */
export async function classifyRequest(prompt: string, orgId: string): Promise<ClassifyResult> {
  const trimmed = (prompt || '').trim();
  if (trimmed.length === 0) return { type: 'simple', confidence: 1, usedFallback: true };

  // A daily/executive brief is one read-only daily_brief turn for Executive.
  // Left to the model router it gets a look-alike playbook (stale deal chase).
  if (DAILY_BRIEF_RE.test(trimmed)) return { type: 'simple', confidence: 0.9, usedFallback: true };

  const complex = COMPLEX_HINTS.test(trimmed);
  const simple = SIMPLE_HINTS.test(trimmed);

  if (simple && !complex) {
    return { type: 'simple', confidence: 0.9, usedFallback: true };
  }

  const playbook = matchPlaybook(trimmed);
  if (playbook && playbook.confidence >= PLAYBOOK_MATCH_THRESHOLD) {
    return {
      type: 'complex',
      confidence: playbook.confidence,
      usedFallback: true,
      playbookId: playbook.playbookId,
    };
  }

  if (complex && !simple && trimmed.length < 150) {
    return { type: 'complex', confidence: 0.85, usedFallback: true };
  }

  const agentType = await classifyWithAgent(trimmed, orgId);
  switch (agentType.type) {
    case 'complex':
      return {
        type: 'complex',
        confidence: agentType.playbookId ? 0.8 : 0.75,
        usedFallback: false,
        model: 'litellm',
        playbookId: agentType.playbookId || null,
      };
    case 'simple':
      return { type: 'simple', confidence: 0.7, usedFallback: false, model: 'litellm' };
    case 'unknown':
      break;
    default: {
      const _exhaustive: never = agentType.type;
      void _exhaustive;
      break;
    }
  }

  if (complex) return { type: 'complex', confidence: 0.6, usedFallback: true };
  return { type: 'simple', confidence: 0.5, usedFallback: true };
}
