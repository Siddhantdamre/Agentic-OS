/**
 * The owner's daily summary: what the assistant did in the last 24 hours and what needs them. Pure, so the wording is
 * tested without a database. The time saved is an estimate and is labelled as one; it is zero when nothing was answered.
 */
export interface DigestCounts {
  /** Customer messages the assistant replied to. */
  answered: number;
  /** Emails and messages the owner approved that were then sent. */
  sent: number;
  /** Approvals waiting for the owner right now. */
  waiting: number;
  /** Enquiries that arrived in the last 24 hours. */
  newInquiries: number;
  /** Showings starting in the next 24 hours. */
  showingsSoon: number;
}

export interface Digest {
  headline: string;
  lines: string[];
  quiet: boolean;
  minutesSaved: number;
  savedNote: string;
}

const MINUTES_PER_ANSWER = 2;

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function buildDigest(c: DigestCounts): Digest {
  const lines: string[] = [];
  if (c.waiting > 0) lines.push(c.waiting === 1 ? '1 approval is waiting for you.' : `${c.waiting} approvals are waiting for you.`);
  if (c.showingsSoon > 0) lines.push(c.showingsSoon === 1 ? '1 showing starts in the next 24 hours.' : `${c.showingsSoon} showings start in the next 24 hours.`);
  if (c.newInquiries > 0) lines.push(`${n(c.newInquiries, 'new enquiry', 'new enquiries')} came in.`);
  if (c.answered > 0) lines.push(`Answered ${n(c.answered, 'customer message', 'customer messages')}.`);
  if (c.sent > 0) lines.push(`Sent ${n(c.sent, 'approved email', 'approved emails')}.`);

  const quiet = lines.length === 0;
  const minutesSaved = Math.max(0, Math.round(c.answered)) * MINUTES_PER_ANSWER;
  const headline = quiet
    ? 'A quiet day so far. Nothing needs you.'
    : c.waiting > 0
      ? 'Something needs you today.'
      : 'Nothing is waiting for you. Here is what happened.';
  const savedNote = minutesSaved > 0
    ? `About ${minutesSaved} minutes of replying saved. This is an estimate of about ${MINUTES_PER_ANSWER} minutes per answer.`
    : '';
  return { headline, lines, quiet, minutesSaved, savedNote };
}
