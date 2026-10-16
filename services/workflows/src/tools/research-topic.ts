/**
 * Cited outside-world research (market, competitors, regulation). Search and page fetches are SSRF-safe, the model
 * only drafts, and a sentence is kept only if a fetched source contains the quoted support and every figure in it.
 * Without a model gateway it says so; it never writes an uncited report.
 */
import { runResearch } from '../research/verifier.js';
import type { Llm } from '../research/plan.js';
import { safeGet } from './safe-url.js';
import { failureOf, searchDuckDuckGo, searchSearXNG, type SearchHit } from './search-providers.js';
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk } from './shared.js';

const ACTIONS = ['read', 'research'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

export function gatewayLlm(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Llm | null {
  const rawBase = env.LITELLM_BASE_URL || '';
  const apiKey = env.LITELLM_API_KEY || env.LITELLM_MASTER_KEY || '';
  if (!rawBase || !apiKey) return null;
  const base = rawBase.replace(/\/$/, '');
  const url = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const model = env.DAREX_RESEARCH_MODEL || env.DAREX_MODEL_STANDARD || 'darex-default';
  return async (prompt: string) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`model gateway returned HTTP ${res.status}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return String(data.choices?.[0]?.message?.content ?? '');
  };
}

async function search(query: string): Promise<SearchHit[]> {
  const attempts = [];
  const searx = searchSearXNG(query);
  if (searx) attempts.push(await searx);
  if (!attempts.some((a) => a.hits.length)) attempts.push(await searchDuckDuckGo(query));
  const hits = attempts.flatMap((a) => a.hits);
  if (!hits.length) {
    const reason = failureOf(attempts);
    if (reason) throw new Error(`web search unavailable (${reason})`);
  }
  return hits;
}

async function fetchText(url: string): Promise<string> {
  const res = await safeGet(url, { maxBytes: 400_000, timeoutMs: 10_000 });
  return res.ok ? res.body : '';
}

async function execute(ctx: ToolActionContext) {
  const { payload, timestamp, actionName } = ctx;
  const base = { tool: 'research_topic', action: actionName || 'read', timestamp };
  const topic = String(payload.topic ?? payload.query ?? '').slice(0, 300).trim();
  if (!topic) return { ...base, status: 'error' as const, message: 'Tell me what to research.', data: {} };
  const llm = gatewayLlm();
  if (!llm) {
    return { ...base, status: 'error' as const, message: 'Cited research needs the model gateway, which is not set up here. Nothing was researched.', data: {} };
  }
  try {
    const r = await runResearch({ topic, search, fetchText, llm, now: () => new Date() });
    const sources = r.sources.map((s, i) => `[${i + 1}] ${s.url}`).join('\n');
    const notes = [
      r.unsupported.length ? `${r.unsupported.length} statement(s) could not be verified and were left out.` : '',
      ...r.caveats,
    ].filter(Boolean);
    return {
      ...base,
      status: 'executed' as const,
      message: [r.report, sources && `Sources:\n${sources}`, `Confidence: ${r.confidence}.`, notes.length ? `Notes: ${notes.join(' ')}` : ''].filter(Boolean).join('\n\n'),
      data: { confidence: r.confidence, sources: r.sources, unsupported: r.unsupported.length, contradictions: r.contradictions },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, status: 'error' as const, message: `Research unavailable: ${message}`, data: {} };
  }
}

export const researchTopic: ToolModule = { actions: ACTIONS, risk: riskFor, confirm: confirmFromRisk(riskFor), execute };
