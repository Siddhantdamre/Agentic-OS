/**
 * Autonomous bug triage — turning a red gate into a diagnosis.
 *
 * This system already has the expensive half of self-repair: fifty-odd
 * deterministic checkers, each of which knows what invariant it protects and
 * says so in its own header. What it never had is the loop that reads a red
 * gate and works out what to do about it. So a failure sat in a terminal until
 * a person read it, and — repeatedly, in this repo's own history — nobody did.
 *
 * ── THE ONE RULE THAT MAKES THIS SAFE TO RUN UNATTENDED ─────────────────────
 *
 * IT DIAGNOSES AND PROPOSES. IT NEVER EDITS, COMMITS, PUSHES OR MIGRATES.
 *
 * An agent that repairs its own source unattended is a different product with
 * a different risk profile. The failure mode is not "a bad patch" — a bad patch
 * gets caught. It is a plausible patch that makes the checker pass while
 * removing the invariant the checker existed to protect. That is unreviewable
 * by construction, because the thing that would have caught it is what was
 * changed. Every proposal here goes to a human, and `self-repair.test.ts`
 * asserts that this module exports nothing capable of writing anything.
 *
 * ── WHY TRIAGE IS DETERMINISTIC AND THE PROPOSAL IS NOT ─────────────────────
 *
 * ADR 14: deterministic gates decide, a model may only tighten. Classification
 * decides whether a human is woken up, so it is code with tests. Only the
 * "what might fix this" step is a model, and it runs on findings that have
 * already been classified as code defects.
 *
 * The classification that matters most is the boring one. In this repo's
 * measured history, the large majority of red gate lines were never code:
 * a missing credential, a package manager that could not launch itself, an
 * upstream provider throttling. An agent that opens a code investigation for
 * those is worse than nothing — it burns tokens and it trains its operator to
 * ignore it.
 */

export type FindingKind = 'code' | 'environment' | 'upstream' | 'unknown';

export interface GateFinding {
  /** The suite or checker that reported it. */
  suite: string;
  /** The failure line, verbatim. Never paraphrased — it is the evidence. */
  detail: string;
  kind: FindingKind;
  /** Why it was classified this way, in words an operator can check. */
  because: string;
  /**
   * Whether a human needs to see this now.
   *
   * An environment finding is actionable but not urgent; an upstream one is
   * usually not actionable at all. Only a code finding stops the line.
   */
  actionable: boolean;
}

/**
 * Patterns that mean "the machine, the account or the network" — never the code.
 *
 * Every entry here is a failure actually observed in this repo, not a guess.
 * Order matters: the first match wins, so the most specific evidence is first.
 */
const ENVIRONMENT_SIGNS: Array<[RegExp, string]> = [
  [/is not recognized as an internal or external command/i, 'a command is missing from PATH'],
  [/command not found/i, 'a command is missing from PATH'],
  [/Cannot find module '[^']*[\\/](?:npm|pnpm|yarn)[\\/]/i, 'the package manager launcher cannot find itself'],
  [/\bENOENT\b/, 'a file or executable the runner expected is absent'],
  [/pnpm is not installed/i, 'pnpm is not installed'],
  [/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT/i, 'a service the suite needs is not reachable'],
  [/password authentication failed|SASL|role "[^"]+" does not exist/i, 'database credentials or role are wrong'],
  [/\b401\b|\b403\b|Unauthorized|Forbidden|AuthenticationRequired/i, 'a credential is missing or rejected'],
  [/requires? [A-Z][A-Z0-9_]{3,}\b|[A-Z][A-Z0-9_]{3,} (?:is )?(?:unset|not set|missing)/, 'a named environment variable is not set'],
  [/no such (?:container|service)|Cannot connect to the Docker daemon/i, 'the container stack is not up'],
  [/FATAL ERROR: .*Allocation failed|heap out of memory/i, 'the build ran out of memory'],
];

/** Patterns that mean a third party failed. Retrying is the response. */
const UPSTREAM_SIGNS: Array<[RegExp, string]> = [
  [/Upstream error from/i, 'the model provider reported its own failure'],
  [/temporarily overloaded|rate.?limit|\b429\b/i, 'a provider is throttling or overloaded'],
  [/\b50[0234]\b|Bad Gateway|Service Unavailable/i, 'a provider returned a server error'],
  [/throttled/i, 'a provider is throttling'],
];

/**
 * Patterns that mean the code is wrong, stated positively.
 *
 * Needed as well as the negative lists: "unknown" and "code" must not be the
 * same bucket. A line nobody recognises is a gap in this triage, and calling it
 * a code defect would send an agent to investigate a phantom.
 */
const CODE_SIGNS: Array<[RegExp, string]> = [
  [/error TS\d+/, 'the compiler rejected the code'],
  [/AssertionError|Expected values to be|to be strictly equal/i, 'an assertion about behaviour failed'],
  [/PARSER STALE/, 'a parser no longer matches the format it parses'],
  [/SyntaxError|ReferenceError|TypeError: (?!fetch failed)/, 'the code threw on its own logic'],
  [/\[FAIL\]|not ok \d|✖/, 'a checker assertion failed'],
  [/is not in the gate|silently outside/i, 'a verification gap the lint exists to prevent'],
];

/**
 * Classify one failure line.
 *
 * Environment and upstream are tested FIRST and deliberately. A type error
 * inside a message about a refused connection is still a refused connection,
 * and the expensive mistake in both directions is the same: sending someone to
 * read code when the machine is broken.
 */
export function classifyFailure(suite: string, detail: string): GateFinding {
  const text = String(detail || '');

  for (const [re, why] of ENVIRONMENT_SIGNS) {
    if (re.test(text)) {
      return { suite, detail: text, kind: 'environment', because: why, actionable: true };
    }
  }
  for (const [re, why] of UPSTREAM_SIGNS) {
    if (re.test(text)) {
      // Not actionable: nobody can fix another company's server, and waking a
      // person for it is how an alarm stops being believed.
      return { suite, detail: text, kind: 'upstream', because: why, actionable: false };
    }
  }
  for (const [re, why] of CODE_SIGNS) {
    if (re.test(text)) {
      return { suite, detail: text, kind: 'code', because: why, actionable: true };
    }
  }
  return {
    suite,
    detail: text,
    kind: 'unknown',
    because: 'no triage rule matched this line — classify it before acting on it',
    actionable: true,
  };
}

/**
 * The order to work through findings.
 *
 * Code defects first, then unknowns — an unclassified line is a gap in this
 * module and must not be buried under environment noise. Environment next,
 * because it is actionable. Upstream last: it is a record, not a task.
 */
const KIND_RANK: Record<FindingKind, number> = { code: 0, unknown: 1, environment: 2, upstream: 3 };

export interface TriageSummary {
  findings: GateFinding[];
  counts: Record<FindingKind, number>;
  /**
   * The verdict a person should read first.
   *
   * Never "all clear" while an unknown remains: an unrecognised failure is not
   * a passing one, and reporting it as fine is the failure this whole file is
   * about.
   */
  verdict: string;
  /** Findings a repair attempt may be proposed for. */
  repairable: GateFinding[];
}

export function triage(raw: Array<{ suite: string; detail: string }>): TriageSummary {
  const findings = (raw || [])
    .filter((r) => r && String(r.detail || '').trim())
    .map((r) => classifyFailure(r.suite, r.detail))
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);

  const counts: Record<FindingKind, number> = { code: 0, environment: 0, upstream: 0, unknown: 0 };
  for (const f of findings) counts[f.kind] += 1;

  // Only code findings get a proposal. An unknown is escalated to a human for
  // classification rather than handed to a model, because a model asked to fix
  // something it cannot characterise will characterise it confidently.
  const repairable = findings.filter((f) => f.kind === 'code');

  let verdict: string;
  if (findings.length === 0) {
    verdict = 'No failures to triage.';
  } else if (counts.code > 0) {
    verdict = `${counts.code} code defect${counts.code === 1 ? '' : 's'} — this is the product, not the machine.`;
  } else if (counts.unknown > 0) {
    verdict = `${counts.unknown} unrecognised failure${counts.unknown === 1 ? '' : 's'} — needs a human to classify. Not clear.`;
  } else if (counts.environment > 0) {
    verdict = `${counts.environment} environment problem${counts.environment === 1 ? '' : 's'} and no code defect. Nothing is wrong with the product.`;
  } else {
    verdict = `${counts.upstream} upstream failure${counts.upstream === 1 ? '' : 's'} and nothing else. Retry; there is nothing here to fix.`;
  }

  return { findings, counts, verdict, repairable };
}

/**
 * The prompt for a repair proposal.
 *
 * Three constraints in it are load-bearing, and each one is a failure this
 * would otherwise produce:
 *
 *   - Name the invariant first. A checker exists to protect something; a patch
 *     written without knowing what will satisfy the assertion by deleting it.
 *   - Say "I cannot tell from this" when the evidence is thin. A model asked
 *     for a patch always produces a patch.
 *   - Propose the smallest change at the point all callers share. This repo's
 *     recurring defect is the same fix applied in one caller and missed in six.
 */
export function buildRepairPrompt(finding: GateFinding, checkerHeader: string): string {
  return [
    'A verification check failed. Diagnose it and propose the smallest correct fix.',
    '',
    `CHECK: ${finding.suite}`,
    `FAILURE (verbatim): ${finding.detail}`,
    `TRIAGE: classified as a code defect because ${finding.because}.`,
    '',
    'WHAT THIS CHECK PROTECTS (from its own header):',
    checkerHeader.trim().slice(0, 3000) || '(no header available)',
    '',
    'Answer with these four sections and nothing else:',
    '1. INVARIANT — what this check exists to protect, in one sentence.',
    '2. CAUSE — the most likely cause, and what in the failure text supports it.',
    '3. FIX — the smallest change that restores the invariant. Name the file and',
    '   the function. If several callers share the defect, fix the shared point',
    '   rather than the caller that happened to be reported.',
    '4. CONFIDENCE — high, medium or low, and what you would need to be sure.',
    '',
    'If the failure text does not support a diagnosis, write exactly:',
    'CANNOT DIAGNOSE FROM THIS EVIDENCE — and say what would be needed.',
    'A fix that makes the check pass without restoring the invariant is the',
    'worst possible answer; say so rather than proposing one.',
  ].join('\n');
}

/**
 * Does a proposal deserve to reach a person?
 *
 * A repair loop that forwards everything is a repair loop nobody reads. Two
 * rejections, both from the same principle: a proposal must be checkable.
 */
export function proposalIsUseful(proposal: string): { useful: boolean; reason: string } {
  const text = String(proposal || '').trim();
  if (!text) return { useful: false, reason: 'empty proposal' };
  if (/^CANNOT DIAGNOSE FROM THIS EVIDENCE/im.test(text)) {
    return { useful: false, reason: 'the model reported the evidence was insufficient — forward the failure, not a guess' };
  }
  if (!/\bFIX\b/i.test(text) || !/\bINVARIANT\b/i.test(text)) {
    return { useful: false, reason: 'proposal did not name both the invariant and a fix' };
  }
  return { useful: true, reason: 'names an invariant and a fix' };
}
