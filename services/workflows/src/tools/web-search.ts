import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk } from './shared.js';
import {
  failureMessage,
  failureOf,
  searchDuckDuckGo,
  searchGoogleNews,
  searchJina,
  searchWikipedia,
  type ProviderResult,
  type SearchHit,
} from './search-providers.js';

const ACTIONS = ['search'] as const;

const QUERY_STOP = new Set([
  'about', 'founder', 'founders', 'founded', 'team', 'tell', 'what', 'who', 'the', 'and', 'for',
  'with', 'from', 'that', 'this', 'company', 'search', 'live', 'web', 'your', 'their',
]);

/** Distinctive query words. "Darex AI" becomes darexai so a different "Darex" company is not a hit. */
export function queryNeedles(query: string): string[] {
  const words = query.toLowerCase().replace(/["']/g, ' ').split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = new Set<string>();
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (words[i + 1] === 'ai' && word.length >= 3 && !QUERY_STOP.has(word)) tokens.add(`${word}ai`);
    if (word.length >= 4 && !QUERY_STOP.has(word)) tokens.add(word);
  }
  const long = [...tokens].filter((token) => token.length >= 6);
  return long.length ? long : [...tokens];
}

function mentionsNeedle(blob: string, needle: string): boolean {
  const text = blob.toLowerCase();
  if (text.includes(needle)) return true;
  if (needle.endsWith('ai') && needle.length > 4) {
    const stem = needle.slice(0, -2);
    return new RegExp(`${stem}[\\s\\-_]*x?ai\\b`).test(text);
  }
  return false;
}

/** Drop hits that never mention a distinctive word from the query (Wikipedia full-text matches). */
export function keepRelevantResults<T extends { title?: string; url?: string; snippet?: string; description?: string; content?: string }>(
  query: string,
  items: T[],
): T[] {
  const needles = queryNeedles(query);
  if (needles.length === 0) return items.slice(0, 5);
  const kept = items.filter((item) => {
    const blob = `${item.title || ''} ${item.snippet || ''} ${item.description || ''} ${item.content || ''} ${item.url || ''}`;
    return needles.some((needle) => mentionsNeedle(blob, needle));
  });
  const peopleFirst = /founder|who founded|co-founder/i.test(query);
  if (!peopleFirst) return kept.slice(0, 5);
  return kept
    .slice()
    .sort((a, b) => Number(isPersonHit(b)) - Number(isPersonHit(a)))
    .slice(0, 5);
}

function isPersonHit(item: { title?: string; snippet?: string; description?: string; content?: string }): boolean {
  const blob = `${item.title || ''} ${item.snippet || ''} ${item.description || ''} ${item.content || ''}`;
  return /founder|co-founder|ceo/i.test(blob) && /[A-Z][a-z]+\s+[A-Z][a-z]+/.test(blob);
}

function coerceSearchQuery(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((part) => coerceSearchQuery(part)).filter(Boolean).join(' ');
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    for (const key of ['query', 'q', 'search', 'text', 'keywords']) {
      const inner = coerceSearchQuery(rec[key]);
      if (inner) return inner;
    }
  }
  return '';
}

function riskFor(_action: string): ToolRisk {
  return 'read';
}

function plainQuery(query: string): string {
  return query.replace(/\bOR\b/gi, ' ').replace(/["']/g, ' ').replace(/\s+/g, ' ').trim();
}

function dedupeHits(hits: SearchHit[]) {
  const seen = new Set<string>();
  const unique: SearchHit[] = [];
  for (const hit of hits) {
    const key = (hit.url || hit.title).replace(/\/$/, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
  }
  return unique;
}

export interface LiveSearch {
  results: SearchHit[];
  attempts: ProviderResult[];
}

/** Tiers run in order until one yields relevant hits; every attempt is kept so a total outage is reported as one. */
export async function searchLive(query: string, fetchImpl: typeof fetch = fetch): Promise<LiveSearch> {
  const plain = plainQuery(query);
  const brand = queryNeedles(query).slice().sort((a, b) => b.length - a.length)[0];
  const founderQuery = /founder|who founded|co-founder/i.test(query) && brand ? `${brand} founder` : '';
  const lookups = [...new Set([plain, founderQuery].filter(Boolean))];
  const tiers: Array<() => Array<Promise<ProviderResult> | null>> = [
    () => [searchJina(plain, fetchImpl), ...lookups.map((lookup) => searchDuckDuckGo(lookup, 6, fetchImpl))],
    () => [searchGoogleNews(plain, 6, fetchImpl)],
    () => [searchWikipedia(plain, 5, fetchImpl)],
  ];
  const attempts: ProviderResult[] = [];
  for (const tier of tiers) {
    const settled = await Promise.all(tier().filter((call): call is Promise<ProviderResult> => call !== null));
    attempts.push(...settled);
    const results = keepRelevantResults(query, dedupeHits(settled.flatMap((attempt) => attempt.hits)));
    if (results.length > 0) return { results, attempts };
  }
  return { results: [], attempts };
}

async function execute(ctx: ToolActionContext) {
  const { payload, timestamp } = ctx;
  const query = coerceSearchQuery(payload.query || payload.q || payload.search);
  if (!query) {
    return { tool: 'web_search', action: 'search', status: 'error' as const, message: 'Search query is required', data: null, timestamp };
  }

  console.log(`[Web Search Tool] Searching “${plainQuery(query)}”...`);
  const { results, attempts } = await searchLive(query);
  const providers = attempts.map((attempt) => ({
    provider: attempt.provider,
    hits: attempt.hits.length,
    latencyMs: attempt.latencyMs,
    ...(attempt.error ? { error: attempt.error.reason, detail: attempt.error.detail } : {}),
  }));
  if (results.length > 0) {
    return {
      tool: 'web_search',
      action: 'search',
      status: 'executed' as const,
      message: `Found ${results.length} sources for "${query}"`,
      data: { query, results, providers },
      timestamp,
    };
  }

  const reason = failureOf(attempts);
  if (reason) {
    console.warn(`[Web Search Tool] All providers failed for “${plainQuery(query)}”: ${providers.map((p) => `${p.provider}=${p.detail}`).join('; ')}`);
    return {
      tool: 'web_search',
      action: 'search',
      status: 'error' as const,
      message: failureMessage(query, reason),
      data: { query, results: [], reason, providers },
      timestamp,
    };
  }

  // The web was checked and nothing relevant came back: a real empty result.
  return {
    tool: 'web_search',
    action: 'search',
    status: 'executed' as const,
    message: `No web search results found for "${query}"`,
    data: { query, results: [], providers },
    timestamp,
  };
}

export const webSearch: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
