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

/** Ask the model to extract findings. Returns null when unavailable. */
async function synthesise(
  topic: string,
  sources: ResearchSource[]
): Promise<{ findings: unknown[]; openQuestions: string[] } | null> {
  const isProd = process.env.NODE_ENV === 'production';
  const rawBase = process.env.LITELLM_BASE_URL || (isProd ? '' : 'http://localhost:4000/v1');
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  const model = process.env.LITELLM_MODEL || 'atomic-agent';
  if (!rawBase || !apiKey) return null;

  const baseUrl = rawBase.replace(/\/$/, '');
  const url = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 1200,
        temperature: 0,
        reasoning: { enabled: false },
        messages: [
          {
            role: 'system',
            content:
              'You extract findings from supplied web excerpts. Cite only the URLs given. Reply with ONLY the JSON object described.',
          },
          { role: 'user', content: buildResearchPrompt(topic, sources) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content || '';

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
  } finally {
    clearTimeout(timer);
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
  for (const q of queries) {
    for (const s of await searchWeb(q)) {
      if (!byUrl.has(s.url)) byUrl.set(s.url, s);
    }
  }
  const sources = Array.from(byUrl.values()).slice(0, maxSources);

  if (sources.length === 0) {
    const hasKey = Boolean(process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY);
    return emptyResult(
      topic,
      hasKey ? 'search returned no usable results' : 'no search provider configured (JINA_API_KEY unset)'
    );
  }

  const synthesised = await synthesise(topic, sources);
  if (!synthesised) {
    return emptyResult(topic, 'synthesis model unavailable — sources were retrieved but not analysed');
  }

  // The pure validator is the gate: it drops any finding citing a URL that was
  // not retrieved, and computes confidence from INDEPENDENT publishers.
  const report = validateFindings(topic, synthesised.findings as any, sources, synthesised.openQuestions);
  return { report, rendered: renderReport(report) };
}
