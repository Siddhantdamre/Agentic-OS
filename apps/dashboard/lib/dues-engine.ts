/**
 * Money owed to the owner: when it is due, how late it is, what interest the law entitles a small supplier to,
 * and how firm the next reminder should be. Pure functions, no database, so the rules are tested on their own.
 *
 * The rules follow the Micro, Small and Medium Enterprises Development Act, 2006 as summarised in the research
 * notes for this feature: the payment is due on the agreed day but never later than 45 days after acceptance,
 * or 15 days if nothing was agreed (section 15); interest on a late payment is three times the bank rate
 * notified by the RBI, compounded with monthly rests (section 16). The bank rate changes, so it is always an
 * input here and the screens must ask the owner to check the current figure. This is not legal advice.
 */

const DAY_MS = 86_400_000;
const MAX_CREDIT_DAYS = 45;
const DEFAULT_CREDIT_DAYS = 15;
/** At least this many days between two reminders to the same buyer. */
const MIN_GAP_DAYS = 3;

export type DueStatus = 'open' | 'paid' | 'disputed';

export interface Due {
  amount: number;
  dueDate: Date;
  status: DueStatus;
  lastReminderAt: Date | null;
  remindersSent: number;
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
const wholeDaysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);

/** The day payment is due: the agreed credit period capped at 45 days, or 15 days if none was agreed. */
export function appointedDay(acceptedOn: Date, agreedCreditDays: number | null | undefined): Date {
  const days = agreedCreditDays == null || agreedCreditDays <= 0 ? DEFAULT_CREDIT_DAYS : Math.min(agreedCreditDays, MAX_CREDIT_DAYS);
  return addDays(acceptedOn, days);
}

export function daysOverdue(dueDate: Date, asOf: Date): number {
  return Math.max(0, wholeDaysBetween(dueDate, asOf));
}

/**
 * Interest owed on a late payment at three times the bank rate (a percentage such as 5.5), compounded monthly:
 * whole months compound, the days left over after the last full month are charged as simple interest on the
 * compounded balance. Rounded to paise.
 */
export function msmeInterest(principal: number, dueDate: Date, asOf: Date, bankRatePercent: number): number {
  const late = daysOverdue(dueDate, asOf);
  if (late <= 0 || !(bankRatePercent > 0) || !(principal > 0)) return 0;
  const annual = (bankRatePercent * 3) / 100;
  const monthly = annual / 12;
  // Whole calendar months since the due day.
  let months = (asOf.getUTCFullYear() - dueDate.getUTCFullYear()) * 12 + (asOf.getUTCMonth() - dueDate.getUTCMonth());
  if (asOf.getUTCDate() < dueDate.getUTCDate()) months -= 1;
  months = Math.max(0, months);
  const afterMonths = new Date(Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth() + months, dueDate.getUTCDate()));
  const leftoverDays = Math.max(0, wholeDaysBetween(afterMonths, asOf));
  const compounded = principal * Math.pow(1 + monthly, months);
  const total = compounded + compounded * annual * (leftoverDays / 365);
  return Math.round((total - principal) * 100) / 100;
}

export type ChaseTone = 'friendly' | 'firm' | 'formal';

export type ChaseStep =
  | { action: 'none'; needsOwnerApproval: false; reason: string }
  | { action: 'wait'; needsOwnerApproval: false; reason: string }
  | { action: 'owner_review'; needsOwnerApproval: true; reason: string }
  | { action: 'remind'; tone: ChaseTone; mentionInterest: boolean; needsOwnerApproval: true; reason: string }
  | { action: 'escalation_pack'; needsOwnerApproval: true; reason: string };

/**
 * What to do about one due today. Nothing is ever sent without the owner's approval; a paid due is never chased;
 * a disputed one goes to the owner, because a reminder cannot settle a disagreement.
 */
export function nextChaseStep(due: Due, asOf: Date): ChaseStep {
  if (due.status === 'paid') return { action: 'none', needsOwnerApproval: false, reason: 'Already paid.' };
  if (due.status === 'disputed') return { action: 'owner_review', needsOwnerApproval: true, reason: 'The buyer disputes this. You decide the next step.' };
  const late = daysOverdue(due.dueDate, asOf);
  if (late <= 0) return { action: 'none', needsOwnerApproval: false, reason: 'Not due yet.' };
  if (late >= 60) return { action: 'escalation_pack', needsOwnerApproval: true, reason: 'More than 60 days late: prepare the interest notice and filing pack for you to review.' };
  if (due.lastReminderAt && wholeDaysBetween(due.lastReminderAt, asOf) < MIN_GAP_DAYS) {
    return { action: 'wait', needsOwnerApproval: false, reason: `Reminded ${wholeDaysBetween(due.lastReminderAt, asOf)} day(s) ago; waiting so the buyer is not pestered.` };
  }
  if (late < 8) return { action: 'remind', tone: 'friendly', mentionInterest: false, needsOwnerApproval: true, reason: 'A few days late: a friendly nudge.' };
  if (late < 31) return { action: 'remind', tone: 'firm', mentionInterest: false, needsOwnerApproval: true, reason: 'A week or more late: a firmer reminder.' };
  return { action: 'remind', tone: 'formal', mentionInterest: true, needsOwnerApproval: true, reason: 'Over 30 days late: a formal reminder that mentions the interest owed.' };
}
