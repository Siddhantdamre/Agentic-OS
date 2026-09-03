/**
 * Deep research activity — runs the loop the planner describes.
 *
 * The planning rules live in the pure `deep-research.ts`, which is where their
 * tests are. This file is the I/O: issue the queries, read the pages, hand the
 * text to the existing synthesis step, and feed what came back into the next
 * round.
 *
 * ── WHAT THIS REUSES, AND WHY THAT MATTERS ──────────────────────────────────
 *
 * Nothing here decides what may be claimed. Discovery goes through the shared
 * provider chain; validation goes through `validateFindings` in
 * `market-research.ts`, which counts INDEPENDENT PUBLISHERS rather than pages
 * and refuses a finding with no source. A second research path with its own
 * looser rules would be a second, quieter way to put an uncited number in front
 * of a customer — the whole point of routing through one validator is that
 * "deeper" cannot come to mean "less strict".
 *
 * FAILS SOFT AND SAYS SO. Every exit returns a report plus a `stopReason` and a
 * plain-language notice. A run that hit the round ceiling is reported as
 * PARTIAL; it is never dressed up as a finished piece of work.
 */

import { llmChat } from '../llm/gateway.js';
import { searchWeb } from '../tools/search-providers.js';
import {
  buildResearchPrompt,
  validateFindings,
  renderReport,
  registrableDomain,
  type ResearchReport,
  type ResearchSource,
} from '../market-research.js';
import {
  planNextRound,
  stopNotice,
  MAX_ROUNDS,
  type ResearchRound,
  type StopReason,
} from '../deep-research.js';

export interface DeepResearchInput {
  orgId: string;
  topic: string;
  /** Pages to read before searching. An owner naming a competitor beats discovery. */
  urls?: string[];
  /** Rounds of search-read-synthesise. Capped at MAX_ROUNDS regardless. */
  maxRounds?: number;
  /** Cap on sources carried into synthesis, to bound the prompt. */
  maxSources?: number;
}

export interface DeepResearchResult {
  report: ResearchReport;
  /** Ready-to-read text: the stop notice, then findings with their citations. */
  rendered: string;
  stopReason: StopReason;
  rounds: ResearchRound[];
  /** Distinct publishers across the whole run. */
  independentDomains: number;
}

const READ_TIMEOUT_MS = 20_000;

/** Read one page. Keyless — the reader endpoint answers unauthenticated. */
async function readUrl(url: string): Promise<ResearchSource | null> {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'text/plain', 'X-Retain-Images': 'none' };
    const key = process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY;
    if (key) headers.Authorization = `Bearer ${key}`;

    const res = await fetch(`https://r.jina.ai/${encodeURIComponent(clean)}`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.text();
    if (!body.trim()) return null;

    const titleLine = body.match(/^Title:\s*(.+)$/m);
    return {
      url: clean,
      title: titleLine ? titleLine[1].trim() : clean,
      snippet: body.slice(0, 6000),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the model for findings AND for what it still cannot answer.
 *
 * The open questions are the engine of the loop, so they are requested
 * explicitly and separately. A model asked only for findings returns findings
 * and stops; asked what it is missing, it names the gap — and the gap is what
 * the next round searches for.
 */
async function synthesise(
  topic: string,
  sources: ResearchSource[],
  orgId: string
): Promise<{ findings: unknown[]; openQuestions: string[] } | null> {
  const out = await llmChat({
    orgId,
    purpose: 'research',
    maxTokens: 1400,
    temperature: 0,
    timeoutMs: 40_000,
    messages: [
      {
        role: 'system',
        content:
          'You extract findings from supplied web excerpts. Cite only the URLs given. '
          + 'List under openQuestions anything a decision-maker would still need to know '
          + 'that these excerpts do not establish. Reply with ONLY the JSON object described.',
      },
      { role: 'user', content: buildResearchPrompt(topic, sources) },
    ],
  });
  if (out.error || !out.content) return null;

  try {
    const fenced = out.content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = (fenced?.[1] || out.content).trim();
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
        ? parsed.openQuestions.map(String).filter((q) => q.trim()).slice(0, 6)
        : [],
    };
  } catch {
    return null;
  }
}

export async function deepResearchActivity(
  input: DeepResearchInput
): Promise<DeepResearchResult> {
  const topic = (input.topic || '').trim();
  const maxSources = Math.max(2, Math.min(24, input.maxSources ?? 12));
  const maxRounds = Math.min(Math.max(1, input.maxRounds ?? MAX_ROUNDS), MAX_ROUNDS);

  const rounds: ResearchRound[] = [];
  const byUrl = new Map<string, ResearchSource>();
  const seenDomains = new Set<string>();
  let findings: unknown[] = [];
  let openQuestions: string[] = [];
  let stopReason: StopReason = 'exhausted';

  const finish = (): DeepResearchResult => {
    // One validator, shared with the single-shot path. "Deeper" must never come
    // to mean "less strict" — see this file's header.
    const report: ResearchReport = validateFindings(
      topic || '(none)',
      findings as Parameters<typeof validateFindings>[1],
      Array.from(byUrl.values()),
      openQuestions
    );
    // Count publishers the way the report itself counts them, so the notice and
    // the body can never disagree about how much evidence there was.
    const domains = report.domainsConsulted.length;
    return {
      report,
      rendered: `${stopNotice(stopReason, rounds.length, domains)}\n\n${renderReport(report)}`,
      stopReason,
      rounds,
      independentDomains: domains,
    };
  };

  if (!topic) {
    stopReason = 'exhausted';
    return finish();
  }

  // Named pages first, before any search. The owner's own competitor list is a
  // stronger starting point than anything discovery surfaces for the topic.
  for (const u of (input.urls || []).slice(0, maxSources)) {
    const s = await readUrl(u);
    if (s && !byUrl.has(s.url)) {
      byUrl.set(s.url, s);
      const d = registrableDomain(s.url);
      if (d) seenDomains.add(d);
    }
  }

  for (;;) {
    const plan = planNextRound(topic, rounds, { maxRounds });
    if (plan.done) {
      stopReason = plan.stopReason ?? 'exhausted';
      break;
    }

    const domainsBefore = seenDomains.size;
    const urlsRead: string[] = [];

    for (const q of plan.queries) {
      const outcome = await searchWeb(q, 5);
      for (const r of outcome.results) {
        if (byUrl.size >= maxSources) break;
        if (byUrl.has(r.url)) continue;
        // Read the page rather than trusting the snippet. A snippet is a
        // fragment chosen by a search engine to match the query, which is the
        // worst possible basis for a claim about what a page says.
        const page = (await readUrl(r.url)) ?? {
          url: r.url,
          title: r.title || r.url,
          snippet: r.snippet,
        };
        if (!page.snippet.trim()) continue;
        byUrl.set(page.url, page);
        urlsRead.push(page.url);
        const d = registrableDomain(page.url);
        if (d) seenDomains.add(d);
      }
    }

    const synthesised = await synthesise(topic, Array.from(byUrl.values()), input.orgId);
    if (!synthesised) {
      // Sources were retrieved but not analysed. Record the round honestly and
      // stop: another round would gather more text nothing can read.
      rounds.push({
        round: rounds.length + 1,
        queries: plan.queries,
        urlsRead,
        newDomains: seenDomains.size - domainsBefore,
        openQuestions: [],
      });
      stopReason = 'no-progress';
      break;
    }

    findings = synthesised.findings;
    openQuestions = synthesised.openQuestions;
    rounds.push({
      round: rounds.length + 1,
      queries: plan.queries,
      urlsRead,
      newDomains: seenDomains.size - domainsBefore,
      openQuestions,
    });
  }

  return finish();
}
