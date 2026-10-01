/**
 * Web search providers behind `web_search`. Each one reports what actually
 * happened: hits, or a typed failure. An outage must never look like "the web
 * has nothing on this" (WEB-B01).
 */

export type SearchFailureReason = 'provider_unavailable' | 'rate_limited' | 'blocked';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Provider that returned the hit. */
  source: string;
  publishedAt?: string;
  /** Relevance score; defaults to 1.0. */
  score?: number;
  /** BCP-47 language tag; defaults to 'en'. */
  lang?: string;
}

export interface ProviderResult {
  provider: string;
  hits: SearchHit[];
  latencyMs: number;
  error?: { reason: SearchFailureReason; detail: string };
}

export class ProviderFailure extends Error {
  constructor(readonly reason: SearchFailureReason, detail: string) {
    super(detail);
    this.name = 'ProviderFailure';
  }
}

export function reasonForStatus(status: number): SearchFailureReason {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'blocked';
  return 'provider_unavailable';
}

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Run one provider call with a timeout; any throw becomes a typed error result. */
export async function runProvider(
  provider: string,
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<SearchHit[]>,
): Promise<ProviderResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const hits = await call(controller.signal);
    return { provider, hits, latencyMs: Date.now() - started };
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (err instanceof ProviderFailure) return { provider, hits: [], latencyMs, error: { reason: err.reason, detail: err.message } };
    const detail = controller.signal.aborted ? `timed out after ${timeoutMs}ms` : (err as Error).message || 'request failed';
    return { provider, hits: [], latencyMs, error: { reason: 'provider_unavailable', detail } };
  } finally {
    clearTimeout(timeout);
  }
}

async function okResponse(res: Response, provider: string): Promise<Response> {
  if (!res.ok) throw new ProviderFailure(reasonForStatus(res.status), `${provider} returned HTTP ${res.status}`);
  return res;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}

/** Jina search; null when no key is configured (not attempted, so not a failure). */
export function searchJina(query: string, fetchImpl: typeof fetch = fetch): Promise<ProviderResult> | null {
  const jinaKey = process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY;
  if (!jinaKey) return null;
  return runProvider('jina', 4000, async (signal) => {
    const res = await okResponse(await fetchImpl(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: { Accept: 'application/json', 'X-Retain-Images': 'none', Authorization: `Bearer ${jinaKey}` },
      signal,
    }), 'jina');
    const data = await res.json() as { data?: Array<{ title?: string; url?: string; description?: string; content?: string; snippet?: string }> };
    const rows = Array.isArray(data.data) ? data.data : [];
    return rows.slice(0, 8).map((row) => ({
      title: String(row.title || query),
      url: String(row.url || ''),
      snippet: String(row.snippet || row.description || row.content || '').slice(0, 280),
      source: 'jina',
      score: 1.0,
      lang: 'en',
    }));
  });
}

export function searchDuckDuckGo(query: string, limit = 5, fetchImpl: typeof fetch = fetch): Promise<ProviderResult> {
  return runProvider('duckduckgo', 6000, async (signal) => {
    const res = await okResponse(await fetchImpl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal,
    }), 'duckduckgo');
    const html = await res.text();
    if (html.includes('anomaly-modal') || html.includes('bots use DuckDuckGo')) {
      throw new ProviderFailure('blocked', 'duckduckgo served a bot challenge');
    }
    const results: SearchHit[] = [];
    const resultBlocks = html.split(/class="result\s/);
    for (let i = 1; i < resultBlocks.length && results.length < limit; i++) {
      const block = resultBlocks[i];
      const urlMatch = block.match(/href="([^"]*uddg=([^"&]+)[^"]*)"/) || block.match(/class="result__url"[^>]*href="([^"]+)"/);
      let targetUrl = '';
      if (urlMatch) {
        targetUrl = urlMatch[2] ? decodeURIComponent(urlMatch[2].split('&')[0]) : urlMatch[1];
        if (targetUrl.startsWith('//')) targetUrl = 'https:' + targetUrl;
      }
      const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const title = titleMatch ? stripTags(titleMatch[1]) : '';
      const snippetMatch = block.match(/class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch ? stripTags(snippetMatch[1]) : '';
      if (snippet || title) {
        results.push({
          title: title || query,
          url: targetUrl || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
          snippet: snippet || title,
          source: 'duckduckgo',
          score: 1.0,
          lang: 'en',
        });
      }
    }
    return results;
  });
}

export function searchWikipedia(query: string, limit = 5, fetchImpl: typeof fetch = fetch): Promise<ProviderResult> {
  return runProvider('wikipedia', 4000, async (signal) => {
    const cleanQuery = query.replace(/^["']|["']$/g, '').trim();
    const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanQuery)}&utf8=&format=json`;
    const res = await okResponse(await fetchImpl(url, {
      headers: { 'User-Agent': 'DarexBot/1.0 (https://darex.ai; bot@darex.ai)', 'Accept': 'application/json' },
      signal,
    }), 'wikipedia');
    const data = await res.json() as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
    const items = Array.isArray(data?.query?.search) ? data.query.search : [];
    return items.slice(0, limit).map((r) => ({
      title: String(r.title || cleanQuery),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r.title || '').replace(/ /g, '_'))}`,
      snippet: stripTags(String(r.snippet || '')),
      source: 'wikipedia',
      score: 1.0,
      lang: 'en',
    }));
  });
}

export function searchGoogleNews(query: string, limit = 5, fetchImpl: typeof fetch = fetch): Promise<ProviderResult> {
  return runProvider('google_news', 5000, async (signal) => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await okResponse(await fetchImpl(url, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' },
      signal,
    }), 'google_news');
    const xml = await res.text();
    const items: SearchHit[] = [];
    const itemMatches = xml.split(/<item>/i);
    for (let i = 1; i < itemMatches.length && items.length < limit; i++) {
      const block = itemMatches[i].split(/<\/item>/i)[0] || '';
      const title = stripTags(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
      const itemUrl = (block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim();
      let desc = stripTags(block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || '');
      const pubDateRaw = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || '').trim();
      let publishedAt: string | undefined;
      if (pubDateRaw) {
        try {
          const d = new Date(pubDateRaw);
          publishedAt = isNaN(d.getTime()) ? undefined : d.toISOString();
        } catch {
          publishedAt = undefined;
        }
      }
      if (publishedAt && desc) desc = `[${publishedAt}] ${desc}`;
      if (title && itemUrl) {
        items.push({ title, url: itemUrl, snippet: desc || title, source: 'google_news', score: 1.0, lang: 'en', ...(publishedAt ? { publishedAt } : {}) });
      }
    }
    return items;
  });
}

/**
 * The search failed only if every provider that was tried errored. One
 * provider answering with zero hits means the web was checked.
 */
export function failureOf(attempts: ProviderResult[]): SearchFailureReason | null {
  if (attempts.length === 0) return 'provider_unavailable';
  if (!attempts.every((attempt) => attempt.error)) return null;
  if (attempts.some((attempt) => attempt.error?.reason === 'rate_limited')) return 'rate_limited';
  if (attempts.every((attempt) => attempt.error?.reason === 'blocked')) return 'blocked';
  return 'provider_unavailable';
}

const REASON_TEXT: Record<SearchFailureReason, string> = {
  provider_unavailable: 'the search providers did not respond',
  rate_limited: 'the search providers are rate-limiting us',
  blocked: 'the search providers refused the request',
};

export function failureMessage(query: string, reason: SearchFailureReason): string {
  return `Web search is unavailable right now (${reason}): ${REASON_TEXT[reason]}. The web was not checked for "${query}", so this is not a "no results" answer.`;
}
