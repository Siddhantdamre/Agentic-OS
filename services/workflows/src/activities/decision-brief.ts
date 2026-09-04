/**
 * GATHER BOTH SIDES, THEN LET THE PURE RULES DECIDE.
 *
 * `decision-brief.ts` holds the judgement — when the two sides may be combined,
 * when a disagreement blocks a recommendation, when to refuse. It is pure, so
 * those rules are exhaustively tested.
 *
 * This file does the I/O and nothing else: read what the workspace knows, read
 * what the world says, ask a model to turn the workspace half into comparable
 * claims, and hand all of it to `buildDecisionBrief`. Deliberately thin — every
 * line of policy that leaks in here is a line that cannot be tested without a
 * database and a model.
 */

import { llmChat } from '../llm/gateway.js';
import { retrieveMemory, formatRetrievedFactsBlock } from '../memory/retrieve.js';
import { deepResearchActivity } from './deep-research.js';
import {
  buildDecisionBrief,
  renderDecisionBrief,
  type DecisionBrief,
  type InternalFact,
} from '../decision-brief.js';

export interface DecisionBriefInput {
  orgId: string;
  /** The owner's question, in their words. */
  question: string;
  /** Rounds of outside research. Defaults low: a brief is not a deep dive. */
  maxRounds?: number;
  maxSources?: number;
  /** Skip the outside half — useful when the question is purely internal. */
  internalOnly?: boolean;
}

export interface DecisionBriefResult {
  brief: DecisionBrief;
  rendered: string;
  /** Which halves actually returned anything, for honest reporting. */
  gathered: { internalFacts: number; externalFindings: number; researchStopReason: string | null };
}

/**
 * Turn retrieved workspace text into claims that can be COMPARED.
 *
 * The market half arrives already structured. The internal half is prose —
 * documents, conversation summaries — so something has to extract the figures.
 *
 * The prompt's whole job is to refuse to guess. A fabricated `subject`/`value`
 * pair here does not produce a vague answer, it produces a CONFLICT finding
 * against the market: the brief would tell an owner their pricing disagrees
 * with the market on the strength of a number the model invented. So: copy
 * figures verbatim or omit them, and every claim must name the source it came
 * from.
 */
async function extractInternalFacts(
  orgId: string,
  question: string,
  factsBlock: string
): Promise<InternalFact[]> {
  if (!factsBlock.trim() || /no stored memory/i.test(factsBlock)) return [];

  const system = [
    'You convert a business\'s OWN records into structured claims for a decision brief.',
    'Reply with ONLY JSON: {"facts":[{"claim":"","source":"","subject":"","value":0,"unit":""}]}.',
    'claim: one sentence, drawn only from the records below.',
    'source: the document or record the claim came from, copied from the text. Never invent one.',
    'subject: a SHORT noun phrase naming the measurable thing, e.g. "booking amount",',
    '  "refund window", "response time". Omit subject and value when the claim is not numeric.',
    'value: the number, copied EXACTLY as written. Never compute, convert, round or estimate.',
    'unit: e.g. INR, percent, days, hours.',
    'If a figure is not stated in the records, OMIT value and subject entirely.',
    'A guessed number is worse than no number: it will be compared against market',
    'data and reported to the owner as a disagreement that does not exist.',
  ].join(' ');

  const user = [
    `Question: ${question}`,
    '',
    'The business\'s own records:',
    factsBlock.slice(0, 9000),
  ].join('\n');

  const out = await llmChat({
    orgId,
    purpose: 'research',
    maxTokens: 900,
    temperature: 0,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  if (out.error || !out.content) return [];

  let parsed: unknown;
  try {
    const m = /\{[\s\S]*\}/.exec(out.content);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch {
    return [];
  }

  const raw = (parsed as { facts?: unknown })?.facts;
  if (!Array.isArray(raw)) return [];

  const facts: InternalFact[] = [];
  for (const r of raw) {
    const rec = r as Record<string, unknown>;
    const claim = String(rec.claim ?? '').trim();
    const source = String(rec.source ?? '').trim();
    if (!claim || !source) continue; // buildDecisionBrief would reject it anyway
    const fact: InternalFact = { claim, source };
    const value = typeof rec.value === 'number' ? rec.value : Number(rec.value);
    const subject = String(rec.subject ?? '').trim();
    // Both or neither: a value without a subject cannot be paired, and a
    // subject without a value invites a bogus pairing.
    if (Number.isFinite(value) && subject) {
      fact.value = value;
      fact.subject = subject;
      const unit = String(rec.unit ?? '').trim();
      if (unit) fact.unit = unit;
    }
    facts.push(fact);
  }
  return facts;
}

/**
 * A brief on one question, from the workspace's records and the outside world.
 *
 * Never throws. A half that fails is a half that returned nothing, and
 * `buildDecisionBrief` already refuses to recommend from one side — so a
 * research outage degrades to "your records say X, nothing to compare it
 * against" rather than to silence or to a confident half-answer.
 */
export async function decisionBriefActivity(
  input: DecisionBriefInput
): Promise<DecisionBriefResult> {
  const orgId = String(input.orgId || '');
  const question = String(input.question || '').trim();

  // ── The workspace's own half ───────────────────────────────────────────────
  let internal: InternalFact[] = [];
  try {
    const memory = await retrieveMemory({ orgId, query: question, tokenBudget: 3000 });
    internal = await extractInternalFacts(orgId, question, formatRetrievedFactsBlock(memory));
  } catch {
    internal = [];
  }

  // ── The world's half ──────────────────────────────────────────────────────
  let research = null;
  let stopReason: string | null = null;
  if (!input.internalOnly) {
    try {
      const r = await deepResearchActivity({
        orgId,
        topic: question,
        maxRounds: input.maxRounds ?? 2,
        maxSources: input.maxSources ?? 8,
      });
      research = r.report;
      stopReason = r.stopReason;
    } catch {
      research = null;
    }
  }

  const brief = buildDecisionBrief({ question, internal, research });

  return {
    brief,
    rendered: renderDecisionBrief(brief),
    gathered: {
      internalFacts: internal.length,
      externalFindings: research?.findings?.length ?? 0,
      researchStopReason: stopReason,
    },
  };
}
