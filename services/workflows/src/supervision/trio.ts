/**
 * THREE ROLES ON EVERY TASK — doer, monitor, learner.
 *
 * The roles already ran; nothing recorded that they had. Their traces were
 * scattered across a dozen work_event kinds, so "was this task supervised?"
 * could only be answered by reconstructing a timeline and hoping nothing was
 * missing. A supervisor nobody can confirm ran is indistinguishable from one
 * that silently stopped.
 *
 * This module turns what happened into one verdict per role. It is pure: no
 * database, no clock, no model — so every rule below is pinned by a test
 * rather than discovered in production.
 *
 * ── WHY THE EXPENSIVE ROLE IS THE OPTIONAL ONE ────────────────────────────
 *
 * A conversation on this deployment measures ~99,000 tokens across three model
 * calls. Making the monitor and the learner into LLM agents would take that
 * past 300,000 per conversation for no correctness gain.
 *
 * The monitor's important judgements are deterministic and must stay that way:
 * fair-housing steering, guaranteed returns and invented legal promises are
 * pattern rules that do not need a model, cannot be argued out of a verdict,
 * and cost nothing. A model is consulted only to TIGHTEN a verdict the
 * deterministic layer already allowed — never to loosen one it refused.
 *
 * So `monitorUsedModel` is tracked as a COST SIGNAL, not a quality one. If it
 * trends toward 1.0 the deterministic layer has stopped carrying its share and
 * the price per conversation is quietly tripling.
 *
 * ── THE LEARNER IS THE POINT ──────────────────────────────────────────────
 *
 * A doer and a monitor make a system that is careful. Only the learner makes
 * one that improves. `learnerFromMonitor` records whether what was learned was
 * CAUSED by the judgement — without it the three are independent observers;
 * with it they are a cycle, and "how often does being judged actually teach it
 * something" becomes a number somebody can watch.
 */

export type DoerOutcome = 'replied' | 'failed' | 'refused' | 'escalated';
export type MonitorVerdict = 'passed' | 'revised' | 'blocked' | 'skipped';
export type LearnerOutcome = 'nothing' | 'gap_recorded' | 'memory_written' | 'both';

export interface TaskSignals {
  /** The doer produced text a customer could receive. */
  replyProduced: boolean;
  /** It declined deliberately — a security refusal is a correct outcome. */
  refused: boolean;
  /** It stopped and asked a person. */
  escalated: boolean;
  /** Turns the agent loop actually used. */
  turns: number;

  /** The monitor refused to let the reply go out. */
  criticBlocked: boolean;
  /** The monitor made it rewrite, and then allowed it. */
  criticRevised: boolean;
  /** Which rule decided. Empty when nothing had to decide. */
  criticReason: string;
  /** A model was consulted, as opposed to the deterministic gates alone. */
  criticUsedModel: boolean;

  /** The learner wrote down a question the agent could not answer. */
  gapRecorded: boolean;
  /** The learner extracted durable facts from the conversation. */
  memoryWritten: boolean;
}

export interface TrioVerdict {
  doerOutcome: DoerOutcome;
  doerTurns: number;
  monitorVerdict: MonitorVerdict;
  monitorReason: string;
  monitorUsedModel: boolean;
  learnerOutcome: LearnerOutcome;
  learnerFromMonitor: boolean;
  /** One sentence an operator can read. Always populated. */
  summary: string;
}

function doerOutcomeOf(s: TaskSignals): DoerOutcome {
  // Order matters and is deliberate. A refusal is a DELIBERATE outcome and
  // must not be filed as a failure: counting security refusals as failures
  // would make the safest agent look like the worst one, and the number would
  // then be used to argue for weakening the refusals.
  if (s.refused) return 'refused';
  if (s.escalated) return 'escalated';
  if (s.replyProduced) return 'replied';
  return 'failed';
}

function monitorVerdictOf(s: TaskSignals): MonitorVerdict {
  if (s.criticBlocked) return 'blocked';
  if (s.criticRevised) return 'revised';
  // Nothing was produced, so there was nothing to judge. Recorded as `skipped`
  // rather than `passed`: a monitor that reports "passed" over an empty reply
  // is claiming a judgement it never made, and a pass rate built on those
  // would be mostly silence.
  if (!s.replyProduced) return 'skipped';
  return 'passed';
}

function learnerOutcomeOf(s: TaskSignals): LearnerOutcome {
  if (s.gapRecorded && s.memoryWritten) return 'both';
  if (s.gapRecorded) return 'gap_recorded';
  if (s.memoryWritten) return 'memory_written';
  return 'nothing';
}

export function judgeTask(signals: TaskSignals): TrioVerdict {
  const doerOutcome = doerOutcomeOf(signals);
  const monitorVerdict = monitorVerdictOf(signals);
  const learnerOutcome = learnerOutcomeOf(signals);

  // Did the judgement cause the learning?
  //
  // Only when the monitor actually intervened AND something was written down.
  // A gap recorded because the agent had no source, on a task the monitor
  // happily passed, is not the loop closing — it is two things happening on
  // the same afternoon, and counting it would inflate the one number that says
  // whether being judged teaches this system anything.
  const monitorIntervened = monitorVerdict === 'blocked' || monitorVerdict === 'revised';
  const learnerFromMonitor = monitorIntervened && learnerOutcome !== 'nothing';

  return {
    doerOutcome,
    doerTurns: Number.isFinite(signals.turns) && signals.turns > 0 ? Math.floor(signals.turns) : 0,
    monitorVerdict,
    monitorReason: monitorVerdict === 'passed' || monitorVerdict === 'skipped'
      ? ''
      : String(signals.criticReason || '').slice(0, 200),
    monitorUsedModel: Boolean(signals.criticUsedModel),
    learnerOutcome,
    learnerFromMonitor,
    summary: summarise(doerOutcome, monitorVerdict, learnerOutcome, learnerFromMonitor),
  };
}

function summarise(
  d: DoerOutcome, m: MonitorVerdict, l: LearnerOutcome, fromMonitor: boolean,
): string {
  const doer =
    d === 'replied' ? 'The agent answered'
      : d === 'refused' ? 'The agent declined, on purpose'
        : d === 'escalated' ? 'The agent asked a person'
          : 'The agent could not answer';

  const monitor =
    m === 'passed' ? 'the check let it through as written'
      : m === 'revised' ? 'the check made it rewrite before sending'
        : m === 'blocked' ? 'the check stopped it and a person was asked'
          : 'there was nothing to check';

  const learner =
    l === 'nothing' ? 'nothing new was learned'
      : l === 'gap_recorded' ? 'the question it could not answer was written down'
        : l === 'memory_written' ? 'it remembered what it was told'
          : 'it both remembered what it was told and wrote down what it could not answer';

  return `${doer}, ${monitor}, and ${learner}${fromMonitor ? ' — because of that judgement' : ''}.`;
}

// ── Reading the trio across many tasks ──────────────────────────────────────

export interface SupervisionStats {
  tasks: number;
  supervised: number;
  answered: number;
  monitorIntervened: number;
  /** null below MIN_SAMPLE — a rate over a handful of tasks is theatre. */
  interventionRatePct: number | null;
  /** How often being judged actually taught it something. */
  loopClosedPct: number | null;
  /** Share of tasks where a MODEL was needed to judge. A cost signal. */
  modelUsedPct: number | null;
  headline: string;
}

export const MIN_SAMPLE = 10;

export function summariseSupervision(rows: Array<{
  monitorVerdict: MonitorVerdict;
  doerOutcome: DoerOutcome;
  learnerFromMonitor: boolean;
  monitorUsedModel: boolean;
}>): SupervisionStats {
  const tasks = rows.length;
  if (tasks === 0) {
    return {
      tasks: 0, supervised: 0, answered: 0, monitorIntervened: 0,
      interventionRatePct: null, loopClosedPct: null, modelUsedPct: null,
      headline: 'No tasks yet.',
    };
  }

  // Every row IS the record that the trio ran; a task with no row never
  // reaches this function, which is exactly why a missing row is the signal.
  const supervised = tasks;
  const answered = rows.filter((r) => r.doerOutcome === 'replied').length;
  const intervened = rows.filter(
    (r) => r.monitorVerdict === 'blocked' || r.monitorVerdict === 'revised').length;
  const closed = rows.filter((r) => r.learnerFromMonitor).length;
  const usedModel = rows.filter((r) => r.monitorUsedModel).length;

  const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
  const enough = tasks >= MIN_SAMPLE;

  return {
    tasks,
    supervised,
    answered,
    monitorIntervened: intervened,
    interventionRatePct: enough ? pct(intervened, tasks) : null,
    // Denominator is INTERVENTIONS, not tasks: "how often did being judged
    // teach it something" is only meaningful over the tasks where it was
    // actually judged. Over all tasks it would mostly measure how rarely the
    // monitor has to act, which is a different and much more flattering
    // question.
    loopClosedPct: intervened >= MIN_SAMPLE ? pct(closed, intervened) : null,
    modelUsedPct: enough ? pct(usedModel, tasks) : null,
    headline: enough
      ? `${intervened} of ${tasks} tasks needed the check to step in`
        + `${closed ? `, and ${closed} of those taught the agent something` : ''}.`
      : `${tasks} task(s) supervised. Too few to quote a rate yet.`,
  };
}
