/** Turns a stored due into what the Money owed screen shows. Pure; the route only adds the database. */
import { daysOverdue, msmeInterest, nextChaseStep, type ChaseStep } from './dues-engine';

export interface DueRow {
  id: string;
  buyer_name: string;
  buyer_phone: string | null;
  buyer_email: string | null;
  invoice_no: string | null;
  amount: string | number;
  currency: string;
  invoice_date: string;
  credit_days: number | null;
  due_date: string;
  status: 'open' | 'paid' | 'disputed';
  paid_at: string | null;
  last_reminder_at: string | null;
  reminders_sent: number;
  note: string | null;
}

export interface DuesSettings {
  /** The RBI bank rate the owner confirmed, as a percentage such as 5.5. Null until they set it. */
  bankRatePercent: number | null;
  /** True only when the owner says the business is a registered micro or small supplier. */
  msmeRegistered: boolean;
}

export interface DueView {
  id: string;
  buyerName: string;
  invoiceNo: string | null;
  amount: number;
  currency: string;
  invoiceDate: string;
  dueDate: string;
  status: DueRow['status'];
  daysLate: number;
  interest: number;
  remindersSent: number;
  lastReminderAt: string | null;
  note: string | null;
  channel: 'whatsapp' | 'email' | null;
  hasContact: boolean;
  step: ChaseStep;
  canRemind: boolean;
  cannotRemindBecause: string | null;
}

export function readDuesSettings(meta: unknown): DuesSettings {
  const raw = (meta && typeof meta === 'object' ? (meta as Record<string, unknown>).dues_settings : null) as Record<string, unknown> | null;
  const rate = raw && typeof raw.bankRatePercent === 'number' && raw.bankRatePercent > 0 && raw.bankRatePercent <= 25 ? raw.bankRatePercent : null;
  return { bankRatePercent: rate, msmeRegistered: raw?.msmeRegistered === true };
}

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);

export function describeDue(row: DueRow, settings: DuesSettings, asOf: Date): DueView {
  const amount = Number(row.amount);
  const due = day(row.due_date);
  const open = row.status !== 'paid';
  const daysLate = open ? daysOverdue(due, asOf) : 0;
  const interest = open && settings.msmeRegistered && settings.bankRatePercent ? msmeInterest(amount, due, asOf, settings.bankRatePercent) : 0;
  const step = nextChaseStep(
    { amount, dueDate: due, status: row.status, lastReminderAt: row.last_reminder_at ? new Date(row.last_reminder_at) : null, remindersSent: row.reminders_sent },
    asOf,
  );
  const channel = row.buyer_phone ? 'whatsapp' : row.buyer_email ? 'email' : null;
  const wantsReminder = step.action === 'remind';
  const cannotRemindBecause = wantsReminder && !channel ? 'Add a phone or email for this buyer to send a reminder.' : wantsReminder ? null : step.reason;
  return {
    id: row.id, buyerName: row.buyer_name, invoiceNo: row.invoice_no, amount, currency: row.currency,
    invoiceDate: row.invoice_date.slice(0, 10), dueDate: row.due_date.slice(0, 10), status: row.status,
    daysLate, interest, remindersSent: row.reminders_sent, lastReminderAt: row.last_reminder_at, note: row.note,
    channel, hasContact: channel !== null, step,
    canRemind: wantsReminder && channel !== null,
    cannotRemindBecause: !open ? 'Already paid.' : !channel && wantsReminder ? cannotRemindBecause : wantsReminder ? null : cannotRemindBecause,
  };
}

export interface DuesTotals {
  owed: number;
  overdue: number;
  overdueCount: number;
  openCount: number;
  paidCount: number;
  interest: number;
}

export function totalsOf(views: DueView[]): DuesTotals {
  const t: DuesTotals = { owed: 0, overdue: 0, overdueCount: 0, openCount: 0, paidCount: 0, interest: 0 };
  for (const v of views) {
    if (v.status === 'paid') { t.paidCount += 1; continue; }
    t.openCount += 1;
    t.owed += v.amount;
    if (v.daysLate > 0) { t.overdue += v.amount; t.overdueCount += 1; t.interest += v.interest; }
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return { ...t, owed: r(t.owed), overdue: r(t.overdue), interest: r(t.interest) };
}
