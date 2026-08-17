/**
 * Org world model — what "normal" looks like for THIS business.
 *
 * Pure module (no Node/pg/fetch): importable from the workflow isolate.
 *
 * WHY
 * Memory stores facts. The outcome ledger measures results. Neither tells the
 * agent what is USUAL for this org, so it cannot notice when something is off.
 * That is the difference between an assistant that answers questions and one
 * that says "this lead has gone quiet — for this segment that usually means
 * it's lost, and it's the third this week."
 *
 * ── THE TRUST PROBLEM WITH ANOMALY DETECTION ────────────────────────────────
 *
 * Anomaly features fail in a predictable way: they are switched on early, when
 * the org has almost no history, and everything looks anomalous. People are
 * alerted about noise, learn to ignore alerts, and the feature is dead — along
 * with confidence in everything near it. Three decisions here exist to prevent
 * exactly that:
 *
 *  1. A MINIMUM SAMPLE, ENFORCED.
 *     Below MIN_BASELINE_SAMPLES there is no baseline and no anomaly — the
 *     honest answer is "not enough history yet", never a guess dressed as one.
 *
 *  2. ROBUST STATISTICS, NOT MEAN/STDDEV.
 *     Business data is skewed and full of legitimate outliers (one enormous
 *     deal, one customer who replies in 3 seconds). A single outlier inflates
 *     the standard deviation enough to hide every real anomaly after it, so
 *     median + MAD are used instead — both resist contamination.
 *
 *  3. DEGENERATE SPREAD IS NOT INFINITE CONFIDENCE.
 *     When MAD is 0 (every observed value identical), a naive robust z-score
 *     divides by zero and reports infinite significance for a value one unit
 *     away. That case is detected and reported as unmeasurable.
 */

/** Below this, no baseline is claimed. Ten is where medians start to mean something. */
export const MIN_BASELINE_SAMPLES = 10;

/** 0.6745 = Φ⁻¹(0.75); scales MAD so a robust z matches a normal z on clean data. */
const MAD_TO_SIGMA = 0.6745;

export type AnomalySeverity = 'none' | 'notable' | 'significant' | 'extreme';

export interface Baseline {
  metric: string;
  /** Number of observations behind this baseline. */
  samples: number;
  median: number;
  /** Median absolute deviation — robust spread. */
  mad: number;
  min: number;
  max: number;
  /** False when there is too little history to say anything. */
  sufficient: boolean;
  /** Why the baseline is or is not usable, in plain words. */
  note: string;
}

export interface AnomalyVerdict {
  metric: string;
  value: number;
  isAnomaly: boolean;
  severity: AnomalySeverity;
  /** Robust z-score. Null when it cannot be computed. */
  robustZ: number | null;
  direction: 'above' | 'below' | 'flat';
  /** Sentence suitable for showing a human. Never overstates certainty. */
  explanation: string;
  baseline: Baseline;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Build a baseline from observed values.
 *
 * Non-finite values are discarded rather than propagating NaN through every
 * downstream comparison — a single bad row must not blind the whole metric.
 */
export function computeBaseline(metric: string, values: readonly number[]): Baseline {
  const clean = (values || []).filter((v) => Number.isFinite(v));
  const samples = clean.length;

  if (samples === 0) {
    return {
      metric, samples: 0, median: 0, mad: 0, min: 0, max: 0,
      sufficient: false,
      note: 'no observations yet',
    };
  }

  const sorted = [...clean].sort((a, b) => a - b);
  const med = median(sorted);
  const deviations = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = median(deviations);

  const sufficient = samples >= MIN_BASELINE_SAMPLES;
  return {
    metric,
    samples,
    median: med,
    mad,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    sufficient,
    note: sufficient
      ? `baseline from ${samples} observations`
      : `only ${samples} observation(s) — need ${MIN_BASELINE_SAMPLES} before calling anything unusual`,
  };
}

function severityFor(absZ: number): AnomalySeverity {
  if (absZ >= 5) return 'extreme';
  if (absZ >= 3.5) return 'significant';
  if (absZ >= 2.5) return 'notable';
  return 'none';
}

/**
 * Compare a value against a baseline.
 *
 * Returns `isAnomaly: false` whenever the answer is genuinely unknown — too
 * little history, or a spread of zero. Silence is the correct output when the
 * data cannot support a claim; a maybe-anomaly is worse than none.
 */
export function detectAnomaly(value: number, baseline: Baseline): AnomalyVerdict {
  const base: AnomalyVerdict = {
    metric: baseline.metric,
    value,
    isAnomaly: false,
    severity: 'none',
    robustZ: null,
    direction: 'flat',
    explanation: '',
    baseline,
  };

  if (!Number.isFinite(value)) {
    return { ...base, explanation: 'value is not a number' };
  }
  if (!baseline.sufficient) {
    return { ...base, explanation: baseline.note };
  }

  const delta = value - baseline.median;
  const direction: AnomalyVerdict['direction'] = delta > 0 ? 'above' : delta < 0 ? 'below' : 'flat';

  if (baseline.mad === 0) {
    // Every observed value was identical. A different value IS notable, but the
    // data cannot say how notable — reporting z = ∞ would be false precision.
    if (delta === 0) {
      return { ...base, direction, explanation: `matches the usual ${baseline.median}` };
    }
    return {
      ...base,
      direction,
      explanation:
        `every one of the ${baseline.samples} previous observations was exactly ${baseline.median}, ` +
        `so ${value} is new — but the spread is zero, so how unusual it is cannot be measured`,
    };
  }

  const robustZ = (MAD_TO_SIGMA * delta) / baseline.mad;
  const severity = severityFor(Math.abs(robustZ));
  const isAnomaly = severity !== 'none';

  return {
    metric: baseline.metric,
    value,
    isAnomaly,
    severity,
    robustZ,
    direction,
    explanation: isAnomaly
      ? `${value} is ${direction} the usual ${baseline.median} (${severity}, ` +
        `${Math.abs(robustZ).toFixed(1)}σ robust, from ${baseline.samples} observations)`
      : `${value} is within the normal range (usual ${baseline.median}, ${baseline.samples} observations)`,
    baseline,
  };
}

export interface WorldModelSnapshot {
  baselines: Record<string, Baseline>;
  anomalies: AnomalyVerdict[];
  /** Metrics that exist but cannot yet be judged. Shown as gaps, not hidden. */
  insufficientMetrics: string[];
}

/**
 * Assemble a snapshot across several metrics.
 *
 * Metrics without enough history are reported in `insufficientMetrics` rather
 * than silently omitted: an owner should be able to see what the system cannot
 * yet tell them, which is itself useful ("keep going, 4 more days of data").
 */
export function buildSnapshot(
  history: Record<string, readonly number[]>,
  current: Record<string, number>
): WorldModelSnapshot {
  const baselines: Record<string, Baseline> = {};
  const anomalies: AnomalyVerdict[] = [];
  const insufficientMetrics: string[] = [];

  for (const metric of Object.keys(history)) {
    const baseline = computeBaseline(metric, history[metric]);
    baselines[metric] = baseline;

    if (!baseline.sufficient) {
      insufficientMetrics.push(metric);
      continue;
    }
    if (!(metric in current)) continue;

    const verdict = detectAnomaly(current[metric], baseline);
    if (verdict.isAnomaly) anomalies.push(verdict);
  }

  // Most severe first: an owner reads the top of a list, so the worst thing
  // must not be third.
  const rank: Record<AnomalySeverity, number> = { extreme: 3, significant: 2, notable: 1, none: 0 };
  anomalies.sort((a, b) => rank[b.severity] - rank[a.severity] || Math.abs(b.robustZ ?? 0) - Math.abs(a.robustZ ?? 0));

  return { baselines, anomalies, insufficientMetrics };
}
