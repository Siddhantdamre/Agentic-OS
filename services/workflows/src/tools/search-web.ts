/**
 * Web search: one function, a chain of providers, and a floor that needs no key.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Search was a single call to `s.jina.ai`, which returns 401 without
 * JINA_API_KEY. That key has never been set in this deployment, so every
 * agent's search returned an error — and it did so in three separate places
 * that each held their own copy of the same Jina call:
 *
 *   tools/web-search.ts             -> "web_search requires JINA_API_KEY"
 *   activities/market-research.ts   -> `if (!jinaKey) return []`
 *   duties.ts KEY_GATED             -> web_search reported "not connected"
 *
 * Three copies is why the outage was invisible: nothing owned it, so nothing
 * could report it. An agent could READ a page somebody named (r.jina.ai answers
 * keyless) but could never FIND one. Reading without finding is a bookmark
 * follower, not a researcher.
 *
 * This module is the single door. Everything that searches the web calls
 * `searchWeb`, and it tries providers in order until one answers:
 *
 *   1. Jina        — best quality, needs JINA_API_KEY
 *   2. Brave       — good quality, needs BRAVE_SEARCH_API_KEY
 *   3. DuckDuckGo  — KEYLESS. HTML, parsed below. The floor.
 *   4. Wikipedia   — KEYLESS. Narrow but always answers, and always factual.
 *
 * Same shape as the model fallback chain, for the same reason: a capability
 * with one provider is a capability with an outage, and a paid front door must
 * fall to a free floor rather than to nothing.
 *
 * ── WHAT THIS MODULE WILL NOT DO ────────────────────────────────────────────
 *
 * It never invents a result. Every returned row carries the URL it came from
 * and the provider that produced it, because a search result that cannot be
 * traced is worse than no search result — an agent will cite it either way.
 * When every provider fails, callers get an empty list and the reason, never a
 * plausible-looking placeholder.
 */

export interface SearchResult {
  url: string;
  title: string;
  /** Text the provider itself returned. Never synthesised here. */
  snippet: string;
  /** Which provider produced this row. Survives into the agent's citation. */
  provider: string;
}

export interface SearchOutcome {
  results: SearchResult[];
  /** The provider that answered, or null when none did. */
  provider: string | null;
  /** Every provider tried and what happened. Empty results are never silent. */
  attempts: Array<{ provider: string; status: 'ok' | 'skipped' | 'failed'; detail: string }>;
}

const SEARCH_TIMEOUT_MS = parseInt(process.env.WEB_SEARCH_TIMEOUT_MS || '12000', 10);

/** A desktop UA. DuckDuckGo's lite endpoint serves an empty page without one. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function getText(url: string, headers: Record<string, string>): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Providers ───────────────────────────────────────────────────────────────

async function jinaSearch(query: string, limit: number): Promise<SearchResult[]> {
  const key = process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY;
  if (!key) throw new Error('skip:no JINA_API_KEY');
  const body = await getText(`https://s.jina.ai/${encodeURIComponent(query)}`, {
    Accept: 'application/json',
    'X-Retain-Images': 'none',
    Authorization: `Bearer ${key}`,
  });
  const data = JSON.parse(body);
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows.slice(0, limit).map((r: any) => ({
    url: String(r.url || ''),
    title: String(r.title || ''),
    snippet: String(r.description || r.content || '').slice(0, 600),
    provider: 'jina',
  })).filter((r: SearchResult) => r.url);
}

async function braveSearch(query: string, limit: number): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  if (!key) throw new Error('skip:no BRAVE_SEARCH_API_KEY');
  const body = await getText(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`,
    { Accept: 'application/json', 'X-Subscription-Token': key }
  );
  const data = JSON.parse(body);
  const rows = Array.isArray(data?.web?.results) ? data.web.results : [];
  return rows.slice(0, limit).map((r: any) => ({
    url: String(r.url || ''),
    title: decodeEntities(String(r.title || '')),
    snippet: decodeEntities(String(r.description || '')).slice(0, 600),
    provider: 'brave',
  })).filter((r: SearchResult) => r.url);
}

/**
 * DuckDuckGo's lite endpoint. Keyless, and therefore the provider that decides
 * whether this product can search at all in a workspace with no budget.
 *
 * Result links are wrapped in a DDG redirector; the real URL is the `uddg`
 * query parameter. A row whose real URL cannot be recovered is DROPPED rather
 * than returned pointing at duckduckgo.com — an agent handed a redirector will
 * cite the redirector.
 */
export function parseDuckDuckGoLite(html: string, limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  const linkRe = /<a[^>]+class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi;
  const hrefRe = /href=["']([^"']+)["']/i;
  const snippetRe = /<td[^>]+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(decodeEntities(sm[1]));

  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html)) !== null && out.length < limit) {
    const tag = m[0];
    const href = hrefRe.exec(tag)?.[1] ?? '';
    let url = '';
    try {
      const abs = href.startsWith('//') ? `https:${href}` : href;
      const parsed = new URL(abs, 'https://duckduckgo.com');
      url = parsed.searchParams.get('uddg')
        || (parsed.hostname.includes('duckduckgo.com') ? '' : parsed.toString());
    } catch {
      url = '';
    }
    if (url) {
      out.push({
        url,
        title: decodeEntities(m[1]),
        snippet: (snippets[i] || '').slice(0, 600),
        provider: 'duckduckgo',
      });
    }
    i += 1;
  }
  return out;
}

/**
 * DuckDuckGo, with backoff, and a failure message that says which failure it is.
 *
 * Measured on this deployment: queries fired back to back — normal for a
 * research loop — come back HTTP 200 with a body containing no results at all,
 * and the same query a minute later returns four. The lite endpoint throttles
 * bursts and recovers on its own.
 *
 * ── THE DISTINCTION THIS FUNCTION EXISTS TO PRESERVE ────────────────────────
 * "Zero results" has two causes that look identical from the outside and need
 * opposite responses:
 *
 *   throttled      — the page came back without the result markup at all.
 *                    Transient. Back off; it fixes itself.
 *   parser stale   — the markup IS there and we extracted nothing from it.
 *                    Permanent, silent, and it turns every web question in the
 *                    product into "the internet had nothing on that".
 *
 * Collapsing them is how a dead parser survives for months, so the second case
 * throws with `PARSER STALE` in the message and `check-web-search.js` fails the
 * build on it.
 */
async function duckDuckGoSearch(query: string, limit: number): Promise<SearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const headers = { 'User-Agent': UA, Accept: 'text/html' };
  const backoffMs = [0, 1500, 4000];
  let lastHtml = '';

  for (const wait of backoffMs) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      lastHtml = await getText(url, headers);
      const rows = parseDuckDuckGoLite(lastHtml, limit);
      if (rows.length > 0) return rows;
    } catch (err: any) {
      lastHtml = '';
      // A transport error on the last attempt is the answer.
      if (wait === backoffMs[backoffMs.length - 1]) throw err;
    }
  }

  if (lastHtml.includes('result-link')) {
    throw new Error('PARSER STALE: result markup present but nothing extracted');
  }
  throw new Error('no results after 3 attempts (throttled — no result markup in response)');
}

/**
 * Does this result actually answer the query that was asked?
 *
 * Wikipedia's search always returns its best guess, and its best guess for
 * "Maharashtra ready reckoner rate hike 2026" was the article "One Rank, One
 * Pension". Nothing about that row announces its irrelevance: it has a real
 * title, a real URL and a real snippet, so an agent hands it to a customer with
 * a citation attached. A confidently-sourced irrelevant answer is worse than
 * "I could not find that", because the citation is what makes it believable.
 *
 * ── WHY A FRACTION AND NOT "ANY TERM" ───────────────────────────────────────
 * The first version of this required one matching term, and Wikipedia answered
 * "best CRM for Indian real estate brokers" with Cognizant, IBM and a list of
 * unicorn startups — every one of them matching on the single word "Indian".
 * One term out of five is a coincidence, not a topic. The bar therefore scales
 * with how specific the question was: half its substantive terms, rounded up.
 *
 * Terms are matched at word start, so "rate" finds "rates" — a suffix is the
 * same word, while an arbitrary substring ("real" inside "unrelated") is not.
 *
 * Applied to providers that never say "no". A general engine returning nothing
 * is a real answer; an encyclopaedia returning its nearest article is not.
 */
export function looksRelevant(
  query: string,
  r: { title: string; snippet: string },
  minFraction = 0.5
): boolean {
  const terms = Array.from(new Set(String(query).toLowerCase().match(/[a-z0-9]{4,}/g) || []));
  if (terms.length === 0) return true;
  const hay = ` ${r.title} ${r.snippet} `.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const hit = terms.filter((t) => hay.includes(` ${t}`)).length;
  return hit >= Math.max(1, Math.ceil(terms.length * minFraction));
}

/**
 * Wikipedia. Keyless, narrow, and last — it will not find a competitor's
 * pricing page. It earns its place as the floor beneath the floor: when every
 * general engine is blocked, an encyclopaedia answer with a real URL still
 * beats "search is unavailable".
 *
 * Filtered through `looksRelevant`, because unlike a general engine Wikipedia
 * never returns nothing — it returns its nearest article, however far away.
 */
async function wikipediaSearch(query: string, limit: number): Promise<SearchResult[]> {
  const body = await getText(
    'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit='
    + limit + '&srsearch=' + encodeURIComponent(query),
    { Accept: 'application/json', 'User-Agent': UA }
  );
  const data = JSON.parse(body);
  const rows = Array.isArray(data?.query?.search) ? data.query.search : [];
  return rows
    .slice(0, limit)
    .map((r: any) => ({
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, '_'))}`,
      title: String(r.title || ''),
      snippet: decodeEntities(String(r.snippet || '')),
      provider: 'wikipedia',
    }))
    .filter((r: SearchResult) => r.title && looksRelevant(query, r));
}

const PROVIDERS: Array<{ name: string; run: (q: string, n: number) => Promise<SearchResult[]> }> = [
  { name: 'jina', run: jinaSearch },
  { name: 'brave', run: braveSearch },
  { name: 'duckduckgo', run: duckDuckGoSearch },
  { name: 'wikipedia', run: wikipediaSearch },
];

/** Providers usable with no credential. Read by the duty planner. */
export const KEYLESS_SEARCH_PROVIDERS = ['duckduckgo', 'wikipedia'];

/**
 * Search the web. Tries each provider in order; the first that returns at
 * least one result wins.
 *
 * A provider returning zero results is treated as a failure and the chain
 * continues — an engine that is up but blocking us returns 200 with an empty
 * body, which is indistinguishable from "no such thing exists" and must not end
 * the chain silently.
 */
export async function searchWeb(query: string, limit = 5): Promise<SearchOutcome> {
  const attempts: SearchOutcome['attempts'] = [];
  const q = String(query || '').trim();
  if (!q) return { results: [], provider: null, attempts };

  for (const p of PROVIDERS) {
    try {
      const results = await p.run(q, limit);
      if (results.length > 0) {
        attempts.push({ provider: p.name, status: 'ok', detail: `${results.length} results` });
        return { results, provider: p.name, attempts };
      }
      attempts.push({ provider: p.name, status: 'failed', detail: 'no results' });
    } catch (err: any) {
      const msg = String(err?.message || err);
      attempts.push({
        provider: p.name,
        status: msg.startsWith('skip:') ? 'skipped' : 'failed',
        detail: msg.replace(/^skip:/, ''),
      });
    }
  }
  return { results: [], provider: null, attempts };
}
