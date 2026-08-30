/**
 * LEADS THAT WENT QUIET — deciding who is worth a nudge, and who must be left alone.
 *
 * This is the first work the agent does that nobody asked it for. Everything
 * else in this system answers when spoken to; a lead who stopped replying will
 * never speak again, which is exactly why the work never gets done and exactly
 * why it is worth money.
 *
 * ── THE FAILURE MODE IS NOT "MISSED A LEAD" ───────────────────────────────
 *
 * It is becoming a pest. A system that chases everybody, twice, at 2am, months
 * later, including the person who already said no and the person who was
 * complaining, does not lose a sale — it loses the customer AND the business's
 * trust in the product, permanently, in about a week.
 *
 * A missed nudge costs one possible sale. A bad nudge costs the account. The
 * asymmetry is enormous, so almost every rule below is a rule about NOT
 * sending, and almost every test is a test that nothing was sent.
 *
 * ── WHY THIS IS PURE ──────────────────────────────────────────────────────
 *
 * No database, no clock, no network: `now` is passed in. Every decision this
 * makes is therefore reproducible and testable, including the ones that depend
 * on the hour of the day in the customer's own timezone — which is otherwise
 * the classic thing that is only ever wrong in production, at 3am, once.
 */

export type SkipReason =
  | 'not_quiet_yet'
  | 'too_old'
  | 'already_nudged_enough'
  | 'cooling_off'
  | 'customer_declined'
  | 'opted_out'
  | 'complaint'
  | 'resolved'
  | 'awaiting_us'
  | 'outside_business_hours'
  | 'no_customer_message';

export interface QuietLeadPolicy {
  /** Silence shorter than this is not "quiet", it is just Tuesday. */
  minQuietDays: number;
  /**
   * Past this, a nudge reads as spam from a company that forgot you. Reviving
   * a four-month-old thread is not diligence, it is a cold approach wearing
   * the costume of a follow-up.
   */
  maxQuietDays: number;
  /** Two is a follow-up. Three is harassment. */
  maxNudges: number;
  /** Never nudge twice inside this window, whatever else is true. */
  cooldownDays: number;
  /** Local hours, inclusive start, exclusive end. */
  businessHours: { start: number; end: number };
  /** IANA zone for the business. */
  timeZone: string;
}

export const DEFAULT_POLICY: QuietLeadPolicy = {
  minQuietDays: 3,
  maxQuietDays: 45,
  maxNudges: 2,
  cooldownDays: 5,
  businessHours: { start: 9, end: 19 },
  timeZone: 'Asia/Kolkata',
};

export interface QuietLead {
  conversationId: string;
  /** When the customer last said anything. Null if they never did. */
  lastCustomerMessageAt: Date | null;
  /** When we last said anything. Null if we never did. */
  lastOutboundAt: Date | null;
  /** How many nudges this lead has already received. */
  nudgesSent: number;
  /** When the most recent nudge went out, if any. */
  lastNudgeAt: Date | null;
  /** Conversation status as stored. */
  status: string;
  /** Whether the contact has asked not to be contacted. */
  optedOut: boolean;
  /**
   * The last thing the customer actually said. Used only to detect an explicit
   * "no" or a complaint — never to guess enthusiasm, because a model reading
   * interest into silence is how this feature would start inventing leads.
   */
  lastCustomerText: string | null;
}

export interface Assessment {
  chase: boolean;
  reason: SkipReason | 'ready';
  /** Which nudge this would be. 0 when not chasing. */
  nudgeNumber: number;
  quietDays: number;
  /** One plain sentence for the operator, always populated. */
  explanation: string;
}

const DAY_MS = 86_400_000;

/**
 * An explicit no.
 *
 * Deliberately narrow. This matches a customer SAYING they are done, not a
 * model's opinion about tone — "not interested", "we went with someone else",
 * "please stop". Widening it to catch hesitation would suppress real leads;
 * narrowing it further would chase people who already said no, which is the
 * single most damaging thing this feature can do.
 */
const DECLINED_RE =
  /\b(?:not\s+interested|no\s+longer\s+interested|went\s+with\s+(?:someone|another|somebody)|already\s+(?:bought|booked|purchased|sorted)|changed\s+my\s+mind|don'?t\s+(?:contact|call|message)\s+me|stop\s+(?:contacting|messaging|calling)|unsubscribe|remove\s+me)\b/i;

/**
 * A complaint is not a lead.
 *
 * Chasing "any update on my refund?" with "just following up — still
 * interested?" is the most tone-deaf message this system could send, and it is
 * the one a naive implementation sends most often, because an unanswered
 * complaint looks exactly like an unanswered enquiry in the data.
 */
const COMPLAINT_RE =
  /\b(?:refund|complaint|complain|not\s+working|broken|faulty|defect|delay(?:ed)?|still\s+waiting|worst|terrible|useless|cheated|fraud|escalate)\b/i;

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / DAY_MS);
}

/**
 * The hour where the CUSTOMER is, not where the server is.
 *
 * Intl is used rather than arithmetic on UTC offsets so that daylight saving
 * is handled by the platform. A hand-rolled offset is correct for about half
 * the year in half the world.
 */
export function localHour(now: Date, timeZone: string): number {
  try {
    const s = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour: '2-digit', hour12: false,
    }).format(now);
    const h = parseInt(s, 10);
    return Number.isFinite(h) ? h : now.getUTCHours();
  } catch {
    // An unknown zone must not silently become UTC-at-midnight and start
    // sending. Fall back to the server hour and let the caller see it.
    return now.getUTCHours();
  }
}

export function withinBusinessHours(now: Date, policy: QuietLeadPolicy): boolean {
  const h = localHour(now, policy.timeZone);
  return h >= policy.businessHours.start && h < policy.businessHours.end;
}

export function assessLead(
  lead: QuietLead,
  now: Date,
  policy: QuietLeadPolicy = DEFAULT_POLICY,
): Assessment {
  const no = (reason: SkipReason, explanation: string, quietDays = 0): Assessment =>
    ({ chase: false, reason, nudgeNumber: 0, quietDays, explanation });

  // A conversation where the customer never spoke is not a lead that went
  // quiet. It is an outbound list, and nudging it is cold outreach the
  // business did not ask this feature to do.
  if (!lead.lastCustomerMessageAt) {
    return no('no_customer_message', 'The customer has never sent a message, so there is nothing to follow up.');
  }

  const quietDays = daysBetween(lead.lastCustomerMessageAt, now);

  if (lead.optedOut) {
    return no('opted_out', 'This contact has asked not to be contacted.', quietDays);
  }

  if (lead.lastCustomerText && DECLINED_RE.test(lead.lastCustomerText)) {
    return no('customer_declined', 'The customer said they are not going ahead.', quietDays);
  }

  if (lead.lastCustomerText && COMPLAINT_RE.test(lead.lastCustomerText)) {
    return no('complaint', 'The last message was a complaint, not an enquiry — following up would read as tone-deaf.', quietDays);
  }

  if (/^(closed|resolved|won|lost)$/i.test(lead.status)) {
    return no('resolved', `This conversation is already ${lead.status.toLowerCase()}.`, quietDays);
  }

  // If the customer spoke last and we never answered, this is not a quiet
  // lead — it is US who went quiet. Sending "just following up" to someone
  // waiting on our reply is insulting; that case belongs to the unanswered
  // queue, not here.
  const weAnsweredAfterThem =
    lead.lastOutboundAt !== null && lead.lastOutboundAt >= lead.lastCustomerMessageAt;
  if (!weAnsweredAfterThem) {
    return no('awaiting_us', 'The customer is waiting on our reply — this is our follow-up to make, not theirs.', quietDays);
  }

  if (quietDays < policy.minQuietDays) {
    return no('not_quiet_yet', `Only ${quietDays} day(s) since they last wrote.`, quietDays);
  }

  if (quietDays > policy.maxQuietDays) {
    return no('too_old', `${quietDays} days is past the point where a follow-up reads as a follow-up.`, quietDays);
  }

  if (lead.nudgesSent >= policy.maxNudges) {
    return no('already_nudged_enough', `Already followed up ${lead.nudgesSent} time(s). Two is a follow-up; three is harassment.`, quietDays);
  }

  if (lead.lastNudgeAt && daysBetween(lead.lastNudgeAt, now) < policy.cooldownDays) {
    return no('cooling_off', `Last followed up ${daysBetween(lead.lastNudgeAt, now)} day(s) ago.`, quietDays);
  }

  if (!withinBusinessHours(now, policy)) {
    return no('outside_business_hours',
      `It is ${localHour(now, policy.timeZone)}:00 for this customer — it will go out during business hours.`,
      quietDays);
  }

  return {
    chase: true,
    reason: 'ready',
    nudgeNumber: lead.nudgesSent + 1,
    quietDays,
    explanation: `Quiet for ${quietDays} days after we replied. This would be follow-up ${lead.nudgesSent + 1} of ${policy.maxNudges}.`,
  };
}

/**
 * Did the last nudge work?
 *
 * The whole feature is worthless without this. A follow-up that goes out and
 * is never measured is indistinguishable from spam, including to the business
 * paying for it — so a nudge is only ever counted as having worked when the
 * customer actually wrote back AFTER it was sent.
 */
export function nudgeOutcome(
  sentAt: Date | null,
  customerRepliedAt: Date | null,
): 'no_reply' | 'replied' | 'not_sent' {
  if (!sentAt) return 'not_sent';
  if (!customerRepliedAt) return 'no_reply';
  // Strictly after. A reply that arrived in the same instant, or before, was
  // not caused by the nudge, and crediting it would flatter the number that
  // decides whether this feature stays switched on.
  return customerRepliedAt.getTime() > sentAt.getTime() ? 'replied' : 'no_reply';
}

export interface RevivalStats {
  sent: number;
  replied: number;
  /** null, never 0, when too few nudges to mean anything. */
  replyRatePct: number | null;
  headline: string;
}

/** Below this, a percentage is theatre. */
export const MIN_SAMPLE = 10;

export function summariseRevival(outcomes: Array<'no_reply' | 'replied' | 'not_sent'>): RevivalStats {
  const sent = outcomes.filter((o) => o !== 'not_sent').length;
  const replied = outcomes.filter((o) => o === 'replied').length;

  if (sent === 0) {
    return { sent: 0, replied: 0, replyRatePct: null, headline: 'No follow-ups have been sent yet.' };
  }
  if (sent < MIN_SAMPLE) {
    return {
      sent, replied, replyRatePct: null,
      headline: `${replied} of ${sent} people replied to a follow-up. Too few to quote a rate yet.`,
    };
  }
  const pct = Math.round((replied / sent) * 1000) / 10;
  return {
    sent, replied, replyRatePct: pct,
    headline: `${replied} of ${sent} people replied to a follow-up they would otherwise never have received (${pct}%).`,
  };
}
