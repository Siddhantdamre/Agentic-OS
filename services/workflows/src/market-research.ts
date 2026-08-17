/**
 * Market research synthesis — sourced findings only.
 *
 * Pure module (no Node/pg/fetch): the web fetching lives in tools/web-search
 * and tools/web-extract; this decides what may be *claimed* from what came back.
 *
 * WHY THIS SHAPE
 * The failure mode of AI research is a confident summary with no traceable
 * origin — the reader cannot tell which parts came from a source, which were
 * inferred, and which the model invented. An owner making a pricing or hiring
 * decision on that is worse off than with no research at all.
 *
 * So a finding here is not a sentence. It is a claim plus its sources, and a
 * confidence derived from how many INDEPENDENT sources support it.
 *
 * ── THE INDEPENDENCE RULE (the part most tools get wrong) ────────────────────
 *
 * Five articles from one site is ONE source, not five. Content farms, syndicated
 * press releases and a site's own /blog, /news and /pricing pages all repeat the
 * same underlying claim. Counting pages instead of publishers manufactures
 * confidence out of duplication — the exact opposite of corroboration.
 * `independentSourceCount` therefore counts distinct registrable domains.
 *
 * A single-source claim is never presented as established fact. It is reported
 * as "one source says", which is both honest and still useful.
 */

export type FindingConfidence = 'unverified' | 'single_source' | 'corroborated' | 'well_established';

export interface ResearchSource {
  url: string;
  title: string;
  /** Text actually retrieved from this URL. Claims must be traceable to it. */
  snippet: string;
  /** ISO date if the source is dated. Undated sources are treated as stale-risk. */
  publishedAt?: string;
}

export interface ResearchFinding {
  /** The claim, in one sentence. */
  claim: string;
  /** Sources supporting it. NEVER empty — a finding without a source is dropped. */
  sources: ResearchSource[];
  /** Distinct registrable domains among the sources. */
  independentSourceCount: number;
  confidence: FindingConfidence;
  /** Plain-language caveat shown alongside the claim. */
  caveat: string;
}

export interface ResearchReport {
  topic: string;
  findings: ResearchFinding[];
  /** Claims discarded during validation, with why. Never silently dropped. */
  rejected: Array<{ claim: string; reason: string }>;
  /** Domains consulted, so a reader can judge the evidence base. */
  domainsConsulted: string[];
  /**
   * What the research could NOT establish. Explicitly surfaced: the gaps in a
   * market scan are often more decision-relevant than the findings.
   */
  openQuestions: string[];
}

/**
 * Registrable domain, lowercased.
 *
 * Deliberately simple: strips `www.` and keeps the last two labels. This treats
 * `blog.acme.com` and `acme.com` as one publisher, which is the intent —
 * a company's blog does not independently corroborate its own pricing page.
 * Two-part public suffixes (`.co.uk`) keep three labels so `bbc.co.uk` and
 * `guardian.co.uk` stay distinct.
 */
export function registrableDomain(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const twoPartTlds = new Set(['co.uk', 'com.au', 'co.in', 'co.jp', 'com.br', 'co.nz', 'org.uk', 'ac.uk']);
    const lastTwo = parts.slice(-2).join('.');
    return twoPartTlds.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
  } catch {
    return '';
  }
}

function confidenceFor(independentSources: number): FindingConfidence {
  if (independentSources >= 3) return 'well_established';
  if (independentSources === 2) return 'corroborated';
  if (independentSources === 1) return 'single_source';
  return 'unverified';
}

function caveatFor(confidence: FindingConfidence, sources: ResearchSource[]): string {
  const undated = sources.filter((s) => !s.publishedAt).length;
  const dateNote =
    undated === sources.length && sources.length > 0
      ? ' Sources are undated, so this may be out of date.'
      : '';

  switch (confidence) {
    case 'well_established':
      return `Reported by ${sources.length} sources across independent publishers.${dateNote}`;
    case 'corroborated':
      return `Reported by two independent publishers.${dateNote}`;
    case 'single_source':
      return `Only one source says this — treat as a lead to verify, not a fact.${dateNote}`;
    default:
      return 'No usable source. Not reportable.';
  }
}

export interface RawFinding {
  claim?: unknown;
  sources?: unknown;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Validate model-proposed findings against the sources actually retrieved.
 *
 * Two rules, both non-negotiable:
 *   1. Every cited URL must be one that was actually fetched. A model citing a
 *      plausible-looking URL it never read is the research equivalent of a
 *      fabricated number.
 *   2. A finding with no surviving source is dropped, not downgraded.
 */
export function validateFindings(
  topic: string,
  raw: RawFinding[] | null | undefined,
  retrieved: ResearchSource[],
  openQuestions: string[] = []
): ResearchReport {
  const byUrl = new Map(retrieved.map((s) => [s.url, s]));
  const rejected: Array<{ claim: string; reason: string }> = [];
  const findings: ResearchFinding[] = [];

  for (const item of Array.isArray(raw) ? raw : []) {
    const claim = asString(item?.claim);
    if (!claim) {
      rejected.push({ claim: '(empty)', reason: 'no claim text' });
      continue;
    }

    const urls = Array.isArray(item?.sources) ? item.sources.map(asString).filter(Boolean) : [];
    if (urls.length === 0) {
      rejected.push({ claim, reason: 'no sources cited' });
      continue;
    }

    // Rule 1: only URLs actually retrieved may be cited.
    const sources: ResearchSource[] = [];
    let fabricated = 0;
    for (const url of urls) {
      const source = byUrl.get(url);
      if (source) sources.push(source);
      else fabricated += 1;
    }

    if (sources.length === 0) {
      rejected.push({
        claim,
        reason: `all ${fabricated} cited URL(s) were never retrieved (fabricated citation)`,
      });
      continue;
    }

    const domains = new Set(sources.map((s) => registrableDomain(s.url)).filter(Boolean));
    const independentSourceCount = domains.size;
    const confidence = confidenceFor(independentSourceCount);

    findings.push({
      claim,
      sources,
      independentSourceCount,
      confidence,
      caveat: caveatFor(confidence, sources),
    });
  }

  // Best-supported first: a reader stops after the top few.
  const rank: Record<FindingConfidence, number> = {
    well_established: 3,
    corroborated: 2,
    single_source: 1,
    unverified: 0,
  };
  findings.sort((a, b) => rank[b.confidence] - rank[a.confidence] || b.sources.length - a.sources.length);

  return {
    topic,
    findings,
    rejected,
    domainsConsulted: Array.from(new Set(retrieved.map((s) => registrableDomain(s.url)).filter(Boolean))).sort(),
    openQuestions,
  };
}

/**
 * Render a report for a business owner.
 *
 * Every claim carries its confidence and its sources inline. There is no
 * "executive summary" that strips the caveats — that is precisely where
 * research tools launder uncertainty into false confidence.
 */
export function renderReport(report: ResearchReport): string {
  const lines: string[] = [`Market research: ${report.topic}`, ''];

  if (report.findings.length === 0) {
    lines.push('No findings could be supported by the sources retrieved.');
    if (report.rejected.length > 0) {
      lines.push(`(${report.rejected.length} proposed claim(s) were dropped for lacking usable sources.)`);
    }
  } else {
    for (const f of report.findings) {
      const label =
        f.confidence === 'single_source' ? 'ONE SOURCE' : f.confidence.replace(/_/g, ' ').toUpperCase();
      lines.push(`[${label}] ${f.claim}`);
      lines.push(`  ${f.caveat}`);
      for (const s of f.sources) lines.push(`  - ${s.title || s.url} — ${s.url}`);
      lines.push('');
    }
  }

  if (report.openQuestions.length > 0) {
    lines.push('Could not be established:');
    for (const q of report.openQuestions) lines.push(`  - ${q}`);
    lines.push('');
  }

  if (report.domainsConsulted.length > 0) {
    lines.push(`Sources consulted: ${report.domainsConsulted.join(', ')}`);
  }

  return lines.join('\n').trim();
}

/** Prompt for the synthesising model. Citation of retrieved URLs only. */
export function buildResearchPrompt(topic: string, sources: ResearchSource[]): string {
  const blocks = sources.map((s, i) =>
    [`[${i + 1}] ${s.title || '(untitled)'}`, `URL: ${s.url}`, `Excerpt: ${s.snippet.slice(0, 800)}`].join('\n')
  );
  return [
    `Extract factual findings about: ${topic}`,
    '',
    'Rules:',
    '- Every finding MUST cite the exact URL(s) it came from, copied from the list below.',
    '- Never cite a URL that is not listed. Never invent a URL.',
    '- Only state what the excerpts actually say. Do not add background knowledge.',
    '- If sources disagree, report that as a separate finding rather than picking one.',
    '',
    'Return ONLY JSON:',
    '{"findings":[{"claim":"<one sentence>","sources":["<url>"]}],"openQuestions":["<what the sources did not answer>"]}',
    '',
    'SOURCES:',
    ...blocks,
  ].join('\n');
}
