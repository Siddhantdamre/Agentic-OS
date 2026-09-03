import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk } from './shared.js';
import { deepResearchActivity } from '../activities/deep-research.js';

const ACTIONS = ['research'] as const;

/**
 * Read-only, like every other research capability. It issues searches and
 * fetches pages; it changes nothing anywhere.
 */
function riskFor(_action: string): ToolRisk {
  return 'read';
}

/**
 * Deep research, as a tool an agent can decide to use.
 *
 * `web_search` answers "what does the first page of results say". This answers
 * "what is actually true about this, and how confident can you be" — several
 * rounds of search, reading the pages rather than the snippets, and a synthesis
 * that counts independent publishers.
 *
 * ── WHY THIS IS A TOOL AND NOT ONLY A WORKFLOW ──────────────────────────────
 * There was already a research workflow, registered and started by nothing. A
 * capability an agent cannot choose to invoke is a capability that runs only
 * when a human remembers it exists, which in this codebase has repeatedly meant
 * never. As a tool it goes through the ordinary allowlist, the ordinary
 * supervision and the ordinary ledger.
 *
 * It costs real model tokens per round, so the result carries the stop reason
 * and the source count. An agent handed a PARTIAL report must be able to see
 * that it is partial.
 */
async function execute(ctx: ToolActionContext) {
  const { payload, timestamp, orgId } = ctx;
  const topic = String(payload.topic || payload.query || payload.q || '').trim();

  if (!topic) {
    return {
      tool: 'deep_research', action: 'research', status: 'error' as const,
      message: 'A topic is required for deep research.', data: null, timestamp,
    };
  }

  const urls = Array.isArray(payload.urls)
    ? payload.urls.map(String).filter((u: string) => /^https?:\/\//i.test(u))
    : [];

  const out = await deepResearchActivity({
    orgId,
    topic,
    urls,
    maxRounds: parseInt(String(payload.maxRounds ?? 3), 10) || 3,
    maxSources: parseInt(String(payload.maxSources ?? 10), 10) || 10,
  });

  const found = out.report.findings.length;
  if (found === 0) {
    // Not an error — "nothing could be established" is a real research result,
    // and reporting it as a failure invites the agent to fall back on its own
    // priors, which is the one outcome this whole path exists to prevent.
    return {
      tool: 'deep_research',
      action: 'research',
      status: 'executed' as const,
      message: `No claim about "${topic}" could be established from sources. ${out.rendered.split('\n')[0]}`,
      data: {
        topic, findings: [], stopReason: out.stopReason,
        independentDomains: out.independentDomains,
        openQuestions: out.report.openQuestions,
        rounds: out.rounds.length,
      },
      timestamp,
    };
  }

  return {
    tool: 'deep_research',
    action: 'research',
    status: 'executed' as const,
    message:
      `${found} sourced finding${found === 1 ? '' : 's'} on "${topic}" `
      + `across ${out.independentDomains} independent source${out.independentDomains === 1 ? '' : 's'} `
      + `(${out.rounds.length} round${out.rounds.length === 1 ? '' : 's'}, stopped: ${out.stopReason}).`,
    data: {
      topic,
      report: out.rendered,
      stopReason: out.stopReason,
      independentDomains: out.independentDomains,
      rounds: out.rounds.length,
      domainsConsulted: out.report.domainsConsulted,
      openQuestions: out.report.openQuestions,
      rejected: out.report.rejected,
    },
    timestamp,
  };
}

export const deepResearch: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
