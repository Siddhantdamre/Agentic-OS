import { createHash } from 'crypto';
import type { ExtractedObligation } from '@darex/shared-types';
import { checkObligorSender, fenceUntrusted, quoteIsGrounded, type MessageSender } from '../untrusted.js';
import { extractOpenLoops } from './obligation-extract.js';
import { inferDueTime } from './due-time.js';
import { keywordSuggestsCommitment } from './keyword-prefilter.js';
import { OBLIGATION_EXTRACTOR_TEMPLATE, renderPrompt } from '../prompts/index.js';

export function shouldSkipObligationClassifier(text: string): boolean {
  return !keywordSuggestsCommitment(text);
}
export function contentHashFor(orgId: string, conversationId: string, promiseSummary: string, obligor: string): string {
  return createHash('sha256')
    .update(`${orgId}:${conversationId}:${promiseSummary.trim().toLowerCase()}:${obligor}`)
    .digest('hex');
}
export function prepareObligations(sourceText: string, rows: ExtractedObligation[], sender: MessageSender) {
  return rows.map((row) => {
    if (!quoteIsGrounded(row.quote, sourceText)) return { ...row, reasonCode: 'ungrounded_quote' as const };
    if (!checkObligorSender(row.obligor, sender).ok) return { ...row, reasonCode: 'obligor_sender_mismatch' as const };
    return row;
  });
}

async function extractWithLiteLLM(text: string, sender: MessageSender): Promise<ExtractedObligation[]> {
  const isProd = process.env.NODE_ENV === 'production';
  const rawBase = process.env.LITELLM_BASE_URL || (isProd ? '' : 'http://localhost:4000/v1');
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  const model = process.env.LITELLM_MODEL || process.env.TRUEFORGE_MODEL || 'darex-default';
  if (!rawBase || !apiKey) return [];
  const prompt = renderPrompt(OBLIGATION_EXTRACTOR_TEMPLATE, {
    org_name: 'this organization', sender_role: sender, iso_ts: new Date().toISOString(),
    tz: 'UTC', message_text: fenceUntrusted(text).text,
  });
  const baseUrl = rawBase.replace(/\/$/, '');
  const url = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, stream: false, max_tokens: 400, temperature: 0, reasoning: { enabled: false },
        messages: [
          { role: 'system', content: 'Extract commitments as JSON only. No tools. Reply {"obligations":[]}.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const match = (data?.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as { obligations?: Array<{ obligor?: string; action?: string; quote?: string; due_text?: string; confidence?: number }> };
    const now = new Date();
    return (parsed.obligations || []).flatMap((row) => {
      const obligor = row.obligor === 'them' ? 'them' : row.obligor === 'us' ? 'us' : null;
      if (!obligor || !row.quote || !row.action) return [];
      const due = inferDueTime(String(row.due_text || row.quote), now);
      return [{ obligor, promiseSummary: row.action.slice(0, 240), quote: row.quote, dueAtIso: due.at.toISOString(), dueBasis: due.basis, confidence: Number(row.confidence) || 0.6 }];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function extractObligations(text: string, sender: MessageSender = 'employee'): Promise<ExtractedObligation[]> {
  const heuristic = sender === 'employee'
    ? extractOpenLoops({ message: text, speaker: 'us', at: new Date() }).map((loop) => ({
        obligor: loop.obligor, promiseSummary: loop.promiseSummary, quote: loop.sourceQuote,
        dueAtIso: loop.targetCheckAt.toISOString(), dueBasis: loop.dueBasis, confidence: 0.7,
      }))
    : [];
  if (shouldSkipObligationClassifier(text) && heuristic.length === 0) return [];
  const modeled = await extractWithLiteLLM(text, sender);
  return modeled.length > 0 ? modeled : heuristic;
}
