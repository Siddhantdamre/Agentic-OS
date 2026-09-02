/**
 * Market research activity — search the web, synthesise SOURCED findings.
 *
 * All I/O lives here; the judgement about what may be claimed lives in the pure
 * `market-research.ts` module, which is where the tests are.
 *
 * FAILS SOFT, ALWAYS AND VISIBLY.
 * Missing search key, no results, model down, unparseable output — every path
 * returns a report with zero findings and a `reason` explaining why. It never
 * throws and never invents a finding to fill the gap. An empty report that says
 * "no search provider configured" is useful; a fabricated one is worse than
 * nothing, because it will be acted on.
 */

import { llmChat } from '../llm/gateway.js';
import {
  buildResearchPrompt,
  validateFindings,
  renderReport,
  type ResearchReport,
  type ResearchSource,
} from '../market-research.js';

export interface ResearchActivityInput {
  orgId: string;
  topic: string;
  /** Extra queries to widen coverage. The topic itself is always searched. */
  queries?: string[];
  /** Cap on sources fed to the model. Keeps the prompt bounded. */
  maxSources?: number;
  /**
   * Pages to read directly, with no search involved.
   *
   * Searching and reading are separate capabilities with separate costs.
   * Discovery — "what exists about this topic" — needs a search provider, and
   * therefore JINA_API_KEY. Reading a page somebody already named needs no key
   * at all: Jina's reader endpoint answers unauthenticated.
   *
   * Without this, an org with no search key got an empty report reading "no
   * search provider configured", even for competitor pages, portal listings and
   * regulator notices whose URLs the owner could simply have supplied. That
   * withheld the whole capability over the half of it that costs money.
   *
   * Named URLs are also the better half for competitive work: an owner knows
   * which three competitors matter, and watching those every morning beats
   * discovering strangers.
   */
  urls?: string[];
}

export interface ResearchActivityResult {
  report: ResearchReport;
  /** Ready-to-read text with confidence and citations attached to each claim. */
  rendered: string;
  /** Present when the run produced nothing; explains which stage was unavailable. */
  reason?: string;
}

function emptyResult(topic: string, reason: string): ResearchActivityResult {
  const report: ResearchReport = {
    topic,
    findings: [],
    rejected: [],
    domainsConsulted: [],
    openQuestions: [],
  };
  return { report, rendered: renderReport(report), reason };
}

/**
 * Search via Jina.
 *
 * Returns [] rather than throwing on any failure — a dead search provider must
 * degrade to "no findings", not to a failed workflow.
 */
async function searchWeb(query: string): Promise<ResearchSource[]> {
  const jinaKey = process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY;
  if (!jinaKey) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: {
        Accept: 'application/json',
        'X-Retain-Images': 'none',
        Authorization: `Bearer ${jinaKey}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const rows = Array.isArray(data?.data) ? data.data : [];

    return rows
      .map((r) => ({
        url: String(r.url ?? ''),
        title: String(r.title ?? ''),
        // Jina names the body differently across result types.
        snippet: String(r.content ?? r.description ?? r.snippet ?? ''),
        publishedAt: typeof r.date === 'string' ? r.date : undefined,
      }))
      .filter((s) => s.url && s.snippet);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read one named page. No API key required.
 *
 * Jina's reader answers unauthenticated (verified: HTTP 200 with real page
 * text), so this is the half of research that works with nothing bought. The
 * key is still sent when present — it raises the rate limit, it is not what
 * makes the call legal.
 *
 * Returns null rather than throwing, for the same reason searchWeb returns []:
 * one unreachable competitor page must degrade that source, never the run.
 */
async function readUrl(url: string): Promise<ResearchSource | null> {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return null;

  const jinaKey = process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const headers: Record<string, string> = { Accept: 'text/plain', 'X-Retain-Images': 'none' };
    if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;

    const res = await fetch(`https://r.jina.ai/${encodeURIComponent(clean)}`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.text();
    if (!body.trim()) return null;

    // The reader prefixes "Title: ..." and "URL Source: ..." lines. Use the
    // title when it is there so citations read as a publisher, not a URL.
    const titleLine = body.match(/^Title:\s*(.+)$/m);
    return {
      url: clean,
      title: titleLine ? titleLine[1].trim() : clean,
      // Bounded: the synthesis prompt holds several sources at once.
      snippet: body.slice(0, 6000),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the model to extract findings. Returns null when unavailable. */
async function synthesise(
  topic: string,
  sources: ResearchSource[],
  orgId: string
): Promise<{ findings: unknown[]; openQuestions: string[] } | null> {
  // Through the gateway: model chosen by the workspace's budget.
  const out = await llmChat({
    orgId,
    purpose: 'research',
    maxTokens: 1200,
    temperature: 0,
    timeoutMs: 30_000,
    messages: [
      {
        role: 'system',
        content:
          'You extract findings from supplied web excerpts. Cite only the URLs given. Reply with ONLY the JSON object described.',
      },
      { role: 'user', content: buildResearchPrompt(topic, sources) },
    ],
  });
  if (out.error || !out.content) return null;
  const content = out.content;
  try {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = (fenced?.[1] || content).trim();
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;

    const parsed = JSON.parse(body.slice(start, end + 1)) as {
      findings?: unknown;
      openQuestions?: unknown;
    };
    return {
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      openQuestions: Array.isArray(parsed.openQuestions)
        ? parsed.openQuestions.map(String).slice(0, 10)
        : [],
    };
  } catch {
    return null;
  }
}

export async function researchTopicActivity(
  input: ResearchActivityInput
): Promise<ResearchActivityResult> {
  const topic = (input.topic || '').trim();
  if (!topic) return emptyResult('(none)', 'no topic supplied');

  const queries = [topic, ...(input.queries || [])].filter(Boolean).slice(0, 4);
  const maxSources = Math.max(1, Math.min(20, input.maxSources ?? 10));

  // Gather, de-duplicating by URL: the same page returned by two queries is one
  // source, and counting it twice would inflate apparent corroboration.
  const byUrl = new Map<string, ResearchSource>();

  // Named pages first: they need no key, and an owner naming a competitor is a
  // stronger signal than anything a search would surface for the same topic.
  for (const u of (input.urls || []).slice(0, maxSources)) {
    const s = await readUrl(u);
    if (s && !byUrl.has(s.url)) byUrl.set(s.url, s);
  }

  for (const q of queries) {
    for (const s of await searchWeb(q)) {
      if (!byUrl.has(s.url)) byUrl.set(s.url, s);
    }
  }
  const sources = Array.from(byUrl.values()).slice(0, maxSources);

  if (sources.length === 0) {
    const hasKey = Boolean(process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY);
    const askedForUrls = (input.urls || []).length > 0;
    // Name the stage that came up empty. "No search provider" is the wrong
    // reason to give someone who supplied URLs and got nothing back.
    return emptyResult(
      topic,
      askedForUrls && !hasKey
        ? 'none of the supplied pages could be read, and no search provider is configured (JINA_API_KEY unset)'
        : askedForUrls
          ? 'none of the supplied pages could be read and search returned no usable results'
          : hasKey
            ? 'search returned no usable results'
            : 'no search provider configured (JINA_API_KEY unset) and no pages were supplied to read'
    );
  }

  const synthesised = await synthesise(topic, sources, input.orgId);
  if (!synthesised) {
    return emptyResult(topic, 'synthesis model unavailable — sources were retrieved but not analysed');
  }

  // The pure validator is the gate: it drops any finding citing a URL that was
  // not retrieved, and computes confidence from INDEPENDENT publishers.
  const report = validateFindings(topic, synthesised.findings as any, sources, synthesised.openQuestions);
  return { report, rendered: renderReport(report) };
}
