/**
 * The Monday email — the only part of this product that goes looking for the
 * customer rather than waiting to be opened.
 *
 * WHY IT EXISTS
 * Every learning loop in this system is PULL. The gap list, the corrections,
 * the impact panel: all of them require somebody to remember to log in, and
 * nobody logs into a dashboard weekly. A loop nobody looks at accumulates
 * nothing, and accumulation is the entire moat — the agent only becomes hard
 * to replace if this business keeps teaching it.
 *
 * So this converts a dashboard into a ritual: one email, Monday morning, that
 * says what happened and gives exactly one thing to do about it.
 *
 * PURE ON PURPOSE — no database, no mail client, no clock.
 * Every number arrives as an argument. That is what makes the wording, the
 * arithmetic and the honesty rules testable without a mail server, and it is
 * why the caveats below can be asserted in a unit test rather than hoped for.
 *
 * TONE
 * Written for a business owner, not an operator. No "autonomous resolution
 * rate", no "knowledge gaps", no percentages without their meaning attached.
 * The reader runs a furniture shop and has four minutes.
 */

export interface DigestGap {
  id: string;
  question: string;
  timesAsked: number;
}

export interface WeeklyDigestData {
  orgName: string;
  /** Conversations that FINISHED last week, split by whether a person stepped in. */
  resolvedAlone: number;
  neededPerson: number;
  /** Same figure for the week before, or null when there is no history yet. */
  previousPct: number | null;
  /** Questions it could not answer, most-asked first. */
  gaps: DigestGap[];
  /** Corrections the team made, and gaps they answered, last week. */
  corrections: number;
  gapsAnswered: number;
  /** Promises made that came due, and how many were kept. */
  promisesKept: number;
  promisesDue: number;
  /** True only when a holdout arm exists. Almost always false. */
  causalComparisonAvailable: boolean;
  /** Absolute URL of the page where gaps are answered. */
  brainUrl: string;
}

export interface WeeklyDigest {
  subject: string;
  text: string;
  html: string;
}

/** Whole numbers unless the fraction matters. "84%" reads; "83.7%" does not. */
function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the Monday email.
 *
 * Returns null when there is genuinely nothing to say — no finished
 * conversations, no open questions, no teaching. An email that reports zero of
 * everything trains the reader to delete it unopened, and the next one that
 * matters goes with it.
 */
export function buildWeeklyDigest(data: WeeklyDigestData): WeeklyDigest | null {
  const finished = data.resolvedAlone + data.neededPerson;
  const alonePct = pct(data.resolvedAlone, finished);
  const hasGaps = data.gaps.length > 0;
  const taught = data.corrections + data.gapsAnswered;

  if (finished === 0 && !hasGaps && taught === 0) return null;

  // ── Subject ───────────────────────────────────────────────────────────────
  // Leads with the number, because that is what decides whether it is opened.
  const subject = alonePct !== null
    ? `Your AI handled ${alonePct}% on its own last week`
    : hasGaps
      ? `${data.gaps.length} question${data.gaps.length === 1 ? '' : 's'} your AI could not answer`
      : `Last week with your AI assistant`;

  const lines: string[] = [];
  const html: string[] = [];

  const h = (s: string) => html.push(s);
  const both = (plain: string, markup: string) => { lines.push(plain); h(markup); };

  both(`Hello ${data.orgName},`, `<p>Hello ${escapeHtml(data.orgName)},</p>`);
  lines.push('');

  // ── What happened ─────────────────────────────────────────────────────────
  if (alonePct !== null) {
    const change = data.previousPct === null ? null : alonePct - data.previousPct;
    // Percentage POINTS, and said in words. "up 17 points" is a fact; "up 23%"
    // is the same fact dressed up, and a business owner who later works that
    // out stops believing the rest of the email.
    const changeText = change === null
      ? 'This is the first week there is enough to compare against.'
      : change > 0
        ? `That is ${change} point${change === 1 ? '' : 's'} better than the week before.`
        : change < 0
          ? `That is ${Math.abs(change)} point${Math.abs(change) === 1 ? '' : 's'} lower than the week before.`
          : 'That is the same as the week before.';

    both(
      `Of the ${finished} conversation${finished === 1 ? '' : 's'} that finished last week, `
        + `your AI handled ${data.resolvedAlone} start to finish without anyone stepping in — `
        + `${alonePct}%. ${changeText}`,
      `<p>Of the <strong>${finished}</strong> conversation${finished === 1 ? '' : 's'} that finished `
        + `last week, your AI handled <strong>${data.resolvedAlone}</strong> start to finish without `
        + `anyone stepping in — <strong>${alonePct}%</strong>. ${escapeHtml(changeText)}</p>`
    );
    lines.push('');

    if (data.neededPerson > 0) {
      // Never netted out of the headline. The half where a person was needed is
      // the honest half, and hiding it is how a report stops being believed.
      both(
        `${data.neededPerson} needed one of your team.`,
        `<p>${data.neededPerson} needed one of your team.</p>`
      );
      lines.push('');
    }
  }

  if (data.promisesDue > 0) {
    const keptPct = pct(data.promisesKept, data.promisesDue);
    both(
      `It promised to come back to ${data.promisesDue} customer${data.promisesDue === 1 ? '' : 's'} `
        + `and did so ${data.promisesKept} time${data.promisesKept === 1 ? '' : 's'} (${keptPct}%).`,
      `<p>It promised to come back to ${data.promisesDue} customer`
        + `${data.promisesDue === 1 ? '' : 's'} and did so <strong>${data.promisesKept}</strong> `
        + `time${data.promisesKept === 1 ? '' : 's'} (${keptPct}%).</p>`
    );
    lines.push('');
  }

  // ── The one thing to do ───────────────────────────────────────────────────
  if (hasGaps) {
    both(
      'Here is what it could not answer. Each one takes about a minute, and it '
        + 'never has to ask again:',
      '<p><strong>Here is what it could not answer.</strong> Each one takes about a '
        + 'minute, and it never has to ask again:</p><ul>'
    );
    for (const gap of data.gaps) {
      const times = gap.timesAsked > 1 ? ` (asked ${gap.timesAsked} times)` : '';
      lines.push(`  - ${gap.question}${times}`);
      h(`<li>${escapeHtml(gap.question)}${times}</li>`);
    }
    h('</ul>');
    lines.push('');
    both(
      `Answer them here: ${data.brainUrl}`,
      `<p><a href="${escapeHtml(data.brainUrl)}">Answer them here</a></p>`
    );
    lines.push('');
  } else if (finished > 0) {
    both(
      'It answered every question it was asked last week — nothing is waiting on you.',
      '<p>It answered every question it was asked last week — nothing is waiting on you.</p>'
    );
    lines.push('');
  }

  // ── What the team taught it ───────────────────────────────────────────────
  if (taught > 0) {
    const parts: string[] = [];
    if (data.corrections > 0) {
      parts.push(`corrected it ${data.corrections} time${data.corrections === 1 ? '' : 's'}`);
    }
    if (data.gapsAnswered > 0) {
      parts.push(`answered ${data.gapsAnswered} question${data.gapsAnswered === 1 ? '' : 's'} for it`);
    }
    const sentence = `Your team ${parts.join(' and ')} last week. It keeps all of that.`;
    both(sentence, `<p>${escapeHtml(sentence)}</p>`);

    // The caveat is the point, not the small print.
    //
    // Teaching and the resolution trend are reported in the same email, and a
    // reader will connect them — so say what can and cannot be concluded. With
    // no holdout there is no control group, and a business that later works
    // out the difference stops trusting every number here.
    if (!data.causalComparisonAvailable && alonePct !== null && data.previousPct !== null) {
      const caveat = 'Both of those changed over the same weeks. We cannot tell you '
        + 'one caused the other — that would need us to hold the AI back from some '
        + 'conversations on purpose to compare, which we have not done.';
      both(caveat, `<p style="color:#666">${escapeHtml(caveat)}</p>`);
    }
    lines.push('');
  }

  return {
    subject,
    text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    html: html.join('\n'),
  };
}
