/**
 * Readable web-search view for the Ask AI thread.
 * The server writes the same shape into the reply; this covers turns
 * that were saved as the placeholder sentence.
 */

import { connectorSignInPath, providerIdForTool, providerIdFromConnectHref } from '@/lib/integrations-catalog';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchView {
  query: string;
  hits: SearchHit[];
  note: string;
  /** Set when every search provider failed: the web was not checked (WEB-B01). */
  failure?: string;
}

export interface StoredToolStep {
  tool?: string;
  toolUsed?: string;
  action?: string;
  result?: string;
  observation?: string;
}

export function isPlaceholderReply(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed || trimmed === '[object Object]') return true;
  return /^i have completed the task\.?$/i.test(trimmed);
}

function decodeEntities(value: string): string {
  let out = value;
  for (let i = 0; i < 3; i += 1) {
    const next = out
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&nbsp;/g, ' ');
    if (next === out) break;
    out = next;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function pullContentBlocks(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    const blocks = Array.isArray(rec.error) ? rec.error : Array.isArray(rec.content) ? rec.content : null;
    if (!blocks) return null;
    const joined = blocks.map((block) => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        return (block as { text: string }).text;
      }
      return '';
    }).join('\n').trim();
    return joined || null;
  } catch {
    return null;
  }
}

/** Tool payloads are fenced for the model, and failed calls come back as error content blocks. */
export function unwrapToolText(raw: string): string {
  const text = raw.trim();
  if (!text || text === '[object Object]') return '';
  const pulled = pullContentBlocks(text);
  if (pulled && pulled !== text) return unwrapToolText(pulled);
  const fence = text.match(/<untrusted_tool_data>\s*([\s\S]*?)\s*<\/untrusted_tool_data>/i);
  if (fence?.[1]) return unwrapToolText(fence[1].trim());
  return text;
}

function usefulText(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = decodeEntities(value);
    if (!trimmed || trimmed === '[object Object]' || trimmed === '<untrusted_tool_data>') return '';
    return trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return usefulText(rec.message) || usefulText(rec.text) || usefulText(rec.query) || usefulText(rec.error);
  }
  return '';
}

function parsePayload(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  const trimmed = unwrapToolText(raw);
  if (!trimmed || trimmed === '[object Object]') return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

const QUERY_STOP = new Set([
  'about', 'founder', 'founders', 'founded', 'team', 'tell', 'what', 'who', 'the', 'and', 'for',
  'with', 'from', 'that', 'this', 'company', 'search', 'live', 'web', 'your', 'their',
]);

function queryNeedles(query: string): string[] {
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

function keepRelevantHits(query: string, hits: SearchHit[]): SearchHit[] {
  const needles = queryNeedles(query);
  if (!query || needles.length === 0) return hits;
  return hits.filter((hit) => {
    const blob = `${hit.title} ${hit.snippet} ${hit.url}`;
    return needles.some((needle) => mentionsNeedle(blob, needle));
  });
}

function asHits(value: unknown): SearchHit[] {
  if (!Array.isArray(value)) return [];
  const hits: SearchHit[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const title = usefulText(rec.title) || usefulText(rec.name);
    const url = usefulText(rec.url) || usefulText(rec.link) || usefulText(rec.href);
    const snippet = usefulText(rec.snippet) || usefulText(rec.description) || usefulText(rec.content);
    if (!title && !url) continue;
    hits.push({ title: title || url, url, snippet: snippet.slice(0, 280) });
    if (hits.length >= 5) break;
  }
  return hits;
}

export function parseSearchView(raw?: string): SearchView | null {
  const parsed = parsePayload(raw);
  if (!parsed) return null;
  const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? parsed.data as Record<string, unknown>
    : parsed;
  const query = usefulText(data.query) || usefulText(parsed.query) || usefulText(data.q);
  const rawHits = asHits(data.results);
  const hits = keepRelevantHits(query, rawHits.length ? rawHits : asHits(parsed.results));
  const note = hits.length === 0 && rawHits.length > 0
    ? ''
    : usefulText(parsed.message);
  const failure = parsed.status === 'error' && hits.length === 0 ? usefulText(data.reason) : '';
  if (!query && hits.length === 0 && !note) return null;
  return failure ? { query, hits, note, failure } : { query, hits, note };
}

/** What to say when search providers failed, instead of "nothing was found". */
export function searchFailureLine(queries: string[], failure: string): string {
  const about = queries.length ? ` for ${queries.map((query) => `“${query}”`).join(' and ')}` : '';
  const why = failure === 'rate_limited' ? 'the search providers are rate-limiting us'
    : failure === 'blocked' ? 'the search providers refused the request'
      : 'the search providers did not respond';
  return `I couldn't check the web${about}: ${why}. This is not a "no results" answer. Try again in a minute.`;
}

export function queryFromToolLabel(raw?: string): string {
  const view = parseSearchView(raw);
  if (view?.query) return view.query;
  const parsed = parsePayload(raw);
  if (!parsed) return '';
  return usefulText(parsed.query) || usefulText(parsed.q) || usefulText(parsed.search);
}

function stepTool(step: StoredToolStep): string {
  return (step.toolUsed || step.tool || step.action || '').toLowerCase();
}

function stepBody(step: StoredToolStep): string {
  return step.result || step.observation || '';
}

export function answerFromSteps(steps?: StoredToolStep[]): string {
  if (!steps?.length) return '';
  const blocks: string[] = [];
  for (const step of steps) {
    const tool = stepTool(step);
    const view = (tool.includes('web_search') || tool === 'search') ? parseSearchView(stepBody(step)) : null;
    if (!view) continue;
    const lines: string[] = [];
    lines.push(view.query ? `### Results for “${view.query}”` : '### Web results');
    if (view.hits.length === 0) {
      lines.push(view.note || 'The search finished without pages to show.');
      blocks.push(lines.join('\n\n'));
      continue;
    }
    if (view.note) lines.push(view.note);
    for (const hit of view.hits) {
      let host = '';
      try {
        host = new URL(hit.url).hostname.replace(/^www\./, '');
      } catch {
        host = '';
      }
      const link = hit.url ? ` [${host || 'source'}](${hit.url})` : '';
      const detail = hit.snippet ? ` — ${hit.snippet}` : '';
      lines.push(`- **${hit.title}**${detail}${link}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n').trim();
}

const DENIES_RESULTS = /unable to find|did not contain|no (relevant )?information|could not find|couldn't find|no results/i;
const SEARCH_DUMP = /### Results for|live web search results for|No web search results found for|matching pages are listed/i;

function namedFounders(hits: SearchHit[]): string[] {
  const names: string[] = [];
  for (const hit of hits) {
    const title = hit.title.trim();
    const head = title.split(/\s+[-–—|@]\s+/)[0]?.trim() || '';
    if (/founder|ceo/i.test(title) && /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/.test(head) && !/darex/i.test(head)) {
      names.push(head);
    }
    const blob = `${title}. ${hit.snippet}`;
    const patterns = [
      /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*(?:\(|,|-|–|—)?\s*(?:is\s+)?(?:a\s+)?(?:co-?)?founder/g,
      /(?:co-?)?founder(?:\s+and\s+ceo)?[:\s@]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/gi,
    ];
    for (const pattern of patterns) {
      for (const match of blob.matchAll(pattern)) {
        const name = match[1]?.trim();
        if (name && !/darex|linkedin|instagram/i.test(name)) names.push(name);
      }
    }
  }
  return [...new Set(names)].slice(0, 3);
}

export function summarizeSearch(query: string, hits: SearchHit[]): string {
  const people = namedFounders(hits);
  const founded = hits.map((hit) => `${hit.title} ${hit.snippet}`).join(' ').match(/founded in (\d{4})/i);
  const official = hits.find((hit) => /darexai\.com/i.test(hit.url)) || hits.find((hit) => hit.snippet.length > 40) || hits[0];
  const lines: string[] = [];
  const blob = hits.map((hit) => `${hit.title} ${hit.snippet}`).join(' ');
  const askingPeople = /founders?|founded|who\s+(founded|is|are)|team/i.test(`${query} ${blob}`) || people.length > 0;
  if (askingPeople) {
    lines.push(people.length
      ? `${people.join(' and ')} ${people.length === 1 ? 'is named as a founder' : 'are named as founders'} in these results.`
      : 'None of these pages name an individual founder.');
  }
  if (founded) lines.push(`A company profile says it was founded in ${founded[1]}.`);
  if (official?.snippet) {
    const snippet = official.snippet.replace(/\s+/g, ' ').trim();
    lines.push(snippet.length > 240 ? `${snippet.slice(0, 237)}…` : snippet);
  }
  if (lines.length === 0 && hits[0]?.title) lines.push(hits[0].title);
  return lines.join(' ') || 'The search finished, but there was nothing readable to show.';
}

export function collectSearchViews(steps?: StoredToolStep[]): SearchView[] {
  if (!steps?.length) return [];
  const views: SearchView[] = [];
  for (const step of steps) {
    const tool = stepTool(step);
    if (!(tool.includes('web_search') || tool === 'search' || tool === 'google_search')) continue;
    const view = parseSearchView(stepBody(step));
    if (view) views.push(view);
  }
  return views;
}

export function visibleAnswer(text: string, steps?: StoredToolStep[]): string {
  const views = collectSearchViews(steps);
  const hits = views.flatMap((view) => view.hits);
  const queries = [...new Set(views.map((view) => view.query).filter(Boolean))];
  const replace = !String(text || '').trim() || isPlaceholderReply(text) || DENIES_RESULTS.test(text || '') || SEARCH_DUMP.test(text || '');
  let body = text;
  if (hits.length > 0 && replace) {
    body = summarizeSearch(queries.join(' '), hits);
  } else if (hits.length === 0 && views.some((view) => view.failure)) {
    body = searchFailureLine(queries, views.find((view) => view.failure)?.failure || '');
  } else if (hits.length === 0 && replace && queries.length > 0) {
    body = `I searched for ${queries.map((query) => `“${query}”`).join(' and ')}, and none of the pages mentioned it.`;
  } else if (isPlaceholderReply(text) || !String(text || '').trim()) {
    body = answerFromSteps(steps) || text || 'I finished, but there was nothing readable to show.';
  }
  return linkUnsignedConnector(body || 'I finished, but there was nothing readable to show.');
}

function soleConnectorMention(text: string): string | null {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  const hits = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const one = tokens[i];
    const two = i + 1 < tokens.length ? `${one}-${tokens[i + 1]}` : '';
    const three = two && i + 2 < tokens.length ? `${two}-${tokens[i + 2]}` : '';
    for (const candidate of [three, two, one]) {
      if (!candidate) continue;
      const id = providerIdForTool(candidate);
      if (id) {
        hits.add(id);
        break;
      }
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}

function linkUnsignedConnector(text: string): string {
  if (!text || !/not connected|not signed in/i.test(text)) return text;
  if (text.includes('](/connectors')) return text;
  const mentioned = soleConnectorMention(text);
  if (/\/connectors\b/.test(text)) {
    return text.replace(/\/connectors(?:\?connect=[A-Za-z0-9._~%-]+)?/g, (match) => {
      const fromHref = providerIdFromConnectHref(match);
      const provider = fromHref || (!match.includes('?') ? mentioned : null);
      if (!provider) return '[Connectors](/connectors)';
      return `[Sign in](${connectorSignInPath(provider)})`;
    });
  }
  if (mentioned) {
    return `${text}\n\n[Sign in](${connectorSignInPath(mentioned)})`;
  }
  return `${text}\n\n[Connect the tool](/connectors)`;
}
