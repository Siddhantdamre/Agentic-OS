/**
 * Turn a finished tool payload into the chat reply when the model
 * stops after the tool call and never writes a sentence.
 */

import { connectorSignInPath } from '@darex/shared-types';

export interface ReplyToolStep {
  tool: string;
  result?: string;
  argsLabel?: string;
}

export function readModelText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) {
    return content.map((part) => readModelText(part)).filter(Boolean).join('');
  }
  if (content && typeof content === 'object') {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === 'string' && rec.text.trim()) return rec.text;
    if ('content' in rec) {
      const nested = readModelText(rec.content);
      if (nested.trim()) return nested;
    }
    const message = usefulText(rec.message);
    if (message) return message;
  }
  return '';
}

export function labelText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export function isPlaceholderReply(text: string): boolean {
  const trimmed = text.trim();
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

function unwrapToolText(raw: string): string {
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

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
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
    hits.push({
      title: title || url,
      url,
      snippet: snippet.slice(0, 280),
    });
    if (hits.length >= 5) break;
  }
  return hits;
}

function searchFromPayload(raw?: string): { query: string; hits: SearchHit[]; note: string; failure: string } | null {
  const parsed = parsePayload(raw);
  if (!parsed) return null;
  const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? parsed.data as Record<string, unknown>
    : parsed;
  const query = usefulText(data.query) || usefulText(parsed.query) || usefulText(data.q);
  const hits = asHits(data.results).length ? asHits(data.results) : asHits(parsed.results);
  const note = usefulText(parsed.message);
  const failure = parsed.status === 'error' && hits.length === 0 ? usefulText(data.reason) : '';
  if (!query && hits.length === 0 && !note) return null;
  return { query, hits, note, failure };
}

function namedFounders(hits: SearchHit[]): string[] {
  const names: string[] = [];
  for (const hit of hits) {
    const title = hit.title.trim();
    const head = title.split(/\s+[-–—|]\s+/)[0]?.trim() || '';
    if (/founder|ceo/i.test(title) && /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/.test(head) && !/darex/i.test(head)) {
      names.push(head);
    }
  }
  return [...new Set(names)].slice(0, 3);
}

function formatSearch(view: { query: string; hits: SearchHit[]; note: string; failure: string }): string {
  if (view.hits.length === 0 && view.failure) {
    const why = view.failure === 'rate_limited' ? 'the search providers are rate-limiting us'
      : view.failure === 'blocked' ? 'the search providers refused the request'
        : 'the search providers did not respond';
    const about = view.query ? ` for “${view.query}”` : '';
    return `I couldn't check the web${about}: ${why}. This is not a "no results" answer. Try again in a minute.`;
  }
  if (view.hits.length === 0) {
    return view.query
      ? `I searched for “${view.query}”, and none of the pages mentioned it.`
      : (view.note || 'The search finished without pages to show.');
  }
  const people = namedFounders(view.hits);
  const hosts = view.hits.map((hit) => {
    try {
      return new URL(hit.url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }).filter(Boolean);
  const aboutPeople = /founder|who founded|co-founder/i.test(view.query);
  const lead = people.length
    ? `${people.join(' and ')} ${people.length === 1 ? 'is' : 'are'} named as a founder in these results for “${view.query}”.`
    : aboutPeople
      ? `I searched for “${view.query}”. None of these pages name an individual founder.`
      : '';
  const detail = view.hits[0]?.snippet ? ` ${view.hits[0].snippet}` : '';
  const sources = hosts.length ? ` Sources: ${hosts.join(', ')}.` : '';
  const written = `${lead}${detail}${sources}`.replace(/\s+/g, ' ').trim();
  return written || `I searched for “${view.query}”, and the pages had no readable summary.`;
}

export function synthesizeReplyFromTools(steps: ReplyToolStep[]): string {
  const blocks: string[] = [];
  for (const step of steps) {
    const tool = (step.tool || '').toLowerCase();
    const raw = step.result || step.argsLabel || '';
    if (tool.includes('web_search') || tool === 'search' || tool === 'google_search') {
      const view = searchFromPayload(raw);
      if (view) blocks.push(formatSearch(view));
      continue;
    }
    const unsigned = unsignedConnectorLine(tool, raw);
    if (unsigned) {
      blocks.push(unsigned);
      continue;
    }
    const parsed = parsePayload(raw);
    const note = usefulText(parsed?.message) || usefulText(parsed?.summary) || usefulText(parsed?.output);
    if (note) blocks.push(note);
  }
  return blocks.join('\n\n').trim();
}

function unsignedConnectorLine(tool: string, raw: string): string | null {
  const parsed = parsePayload(raw);
  if (!parsed) return null;
  const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? parsed.data as Record<string, unknown>
    : null;
  const connected = data ? data.connected : parsed.connected;
  const message = usefulText(parsed.message);
  if (connected !== false && !/not connected|not signed in/i.test(message)) return null;
  const fromData = data && typeof data.setupUrl === 'string' ? data.setupUrl : '';
  const fromParsed = typeof parsed.setupUrl === 'string' ? parsed.setupUrl : '';
  const path = fromData || fromParsed || connectorSignInPath(tool);
  const name = (tool || 'this connector').replace(/^mcp\.darex\./, '').replace(/[_-]/g, ' ');
  return `${name} is not signed in. Connect it at ${path}. The rest of this request uses the tools that are signed in.`;
}

const WEAK_REPLY = /matching pages are listed|i have completed the task|unable to find|could not find|couldn't find|no (relevant )?information|did not contain|nothing readable to show/i;

export function replyForTurn(modelReply: string, steps: ReplyToolStep[]): string {
  const cleaned = modelReply.trim();
  const fromTools = synthesizeReplyFromTools(steps);
  if (!cleaned || isPlaceholderReply(cleaned) || WEAK_REPLY.test(cleaned)) {
    return fromTools || cleaned || 'The search finished, but there was nothing readable to show.';
  }
  return cleaned;
}

/**
 * A turn that paused for approval often ends with no model text. Say what is
 * waiting instead of the generic "nothing readable" fallback. Returns null
 * when the model already wrote a real reply.
 */
export function replyForPausedTurn(modelReply: string, toolNames: string[]): string | null {
  const cleaned = modelReply.trim();
  if (cleaned && !isPlaceholderReply(cleaned) && !WEAK_REPLY.test(cleaned)) return null;
  const names = Array.from(new Set(toolNames.map((n) => n.replace(/^mcp\.darex\./, '').replace(/[_-]+/g, ' ').trim()).filter(Boolean)));
  if (names.length === 0) return null;
  return `This needs your approval before it runs: ${names.join(', ')}. Approve or deny it below. Nothing has been sent yet.`;
}
