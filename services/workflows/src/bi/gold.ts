/**
 * Fixed in-memory dataset, a JS twin of each metric's SQL, 40 gold questions
 * and 40 labelled answers (20 correct, 20 deliberately wrong).
 */
import { METRIC_BY_ID } from './metrics.js';
import type { ComputedValue } from './numbers.js';

export const ORG = 'org-1';
export const AS_OF = '2026-10-16';
export const FROM = '2026-10-01';
export const TO = '2026-10-16';

interface Due { org: string; amount: number; due: string; status: 'open' | 'paid' | 'disputed'; paid?: string }
interface Inq { org: string; created: string; updated: string; status: string; deleted?: boolean }
interface Listing { org: string; status: string }

const dues: Due[] = [
  { org: ORG, amount: 480000, due: '2026-09-10', status: 'open' },
  { org: ORG, amount: 1250000, due: '2026-10-01', status: 'open' },
  { org: ORG, amount: 72500, due: '2026-10-15', status: 'open' },
  { org: ORG, amount: 300000, due: '2026-10-20', status: 'open' },
  { org: ORG, amount: 150000, due: '2026-10-16', status: 'open' },
  { org: ORG, amount: 90000, due: '2026-08-01', status: 'disputed' },
  { org: ORG, amount: 200000, due: '2026-10-02', status: 'paid', paid: '2026-10-03' },
  { org: ORG, amount: 340000, due: '2026-10-09', status: 'paid', paid: '2026-10-10' },
  { org: ORG, amount: 100000, due: '2026-09-19', status: 'paid', paid: '2026-09-20' },
  { org: 'org-2', amount: 999999, due: '2026-09-01', status: 'open' },
];
const inqs: Inq[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((d): Inq => ({ org: ORG, created: `2026-10-0${d}`, updated: `2026-10-0${d}`, status: 'new' })),
  ...[9, 10, 11, 12].map((d): Inq => ({ org: ORG, created: `2026-10-${String(d).padStart(2, "0")}`, updated: `2026-10-${d + 2}`, status: 'closed' })),
  { org: ORG, created: '2026-09-20', updated: '2026-09-25', status: 'closed' },
  { org: ORG, created: '2026-09-28', updated: '2026-09-28', status: 'new' },
  { org: ORG, created: '2026-10-05', updated: '2026-10-05', status: 'new', deleted: true },
  { org: 'org-2', created: '2026-10-05', updated: '2026-10-05', status: 'new' },
];
const listings: Listing[] = [
  ...Array.from({ length: 7 }, (): Listing => ({ org: ORG, status: 'active' })),
  { org: ORG, status: 'sold' }, { org: ORG, status: 'sold' }, { org: 'org-2', status: 'active' },
];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const within = (d: string) => d >= FROM && d <= TO;

/** What each metric's SQL returns on the fixture above (org-1 only). */
export function computeAll(): ComputedValue[] {
  const mine = dues.filter((d) => d.org === ORG);
  const open = mine.filter((d) => d.status === 'open');
  const overdue = open.filter((d) => d.due < AS_OF);
  const values: Record<string, number> = {
    overdue_total: sum(overdue.map((d) => d.amount)),
    overdue_count: overdue.length,
    overdue_share: (100 * sum(overdue.map((d) => d.amount))) / sum(open.map((d) => d.amount)),
    paid_in_range: sum(mine.filter((d) => d.status === 'paid' && within(d.paid!)).map((d) => d.amount)),
    inquiries_in_range: inqs.filter((i) => i.org === ORG && !i.deleted && within(i.created)).length,
    inquiries_closed: inqs.filter((i) => i.org === ORG && !i.deleted && i.status === 'closed' && within(i.updated)).length,
    active_listings: listings.filter((l) => l.org === ORG && l.status === 'active').length,
  };
  return Object.entries(values).map(([id, value]) => {
    const def = METRIC_BY_ID[id];
    const period = def.params.some((p) => p.name === 'as_of') ? { asOf: AS_OF }
      : def.params.length ? { from: FROM, to: TO } : undefined;
    return { id, label: def.label, unit: def.unit, value, query: def.sql, period };
  });
}

export interface GoldQuestion { q: string; id: string | null; expect: string; confidence: 'high' | 'medium' | 'low' }
const ID = (id: string, expect: string, qs: string[], confidence: 'high' | 'medium' = 'high'): GoldQuestion[] =>
  qs.map((q) => ({ q, id, expect, confidence }));

export const GOLD_QUESTIONS: GoldQuestion[] = [
  ...ID('overdue_total', '₹18,02,500', [
    'What is my total overdue amount?', 'How much money is overdue?', 'Mera kitna udhaar baaki hai?',
    'Kitna paisa overdue hai?', 'Total outstanding overdue dues batao', 'Meri overdue payments kitni hain?']),
  ...ID('overdue_count', '3 invoice', [
    'How many invoices are overdue?', 'Number of overdue bills?', 'Kitne invoice overdue hain?', 'Overdue dues ka count batao']),
  ...ID('overdue_share', '80.0%', [
    'What percent of my dues are overdue?', 'Overdue share of open dues?', 'Kitna percent dues overdue hai?', 'Overdue dues ka hissa batao', 'Overdue dues kitne percent hain?']),
  ...ID('paid_in_range', '₹5,40,000', [
    'How much payment was received?', 'How much have I collected?', 'Kitna paisa vasool hua?',
    'Total paid amount batao', 'Mere paise mile kitne?']),
  ...ID('inquiries_in_range', '12', [
    'How many new inquiries did I get?', 'Number of enquiries?', 'Kitni inquiry hain?', 'Show me the count of leads',
    'Kitne leads hain mere?']),
  ...ID('inquiries_closed', '4', [
    'How many inquiries were closed?', 'Kitni inquiry close hui?', 'Number of deals closed in inquiries?', 'Kitne leads close hue?']),
  ...ID('active_listings', '7', [
    'How many active listings do I have?', 'Kitne listing active hain?', 'Count of my properties listed']),
  ...ID('overdue_total', '₹18,02,500', ['How much is overdue this month?', 'Is mahine kitna udhaar baaki hai?'], 'medium'),
  ...[
    'What is my profit margin?', 'Kal ka weather kya hai?', 'Mera GST kitna banta hai?', 'Which customer is my best?',
    'Predict next month sales', 'Overdue aur paid dono ka total batao',
  ].map((q): GoldQuestion => ({ q, id: null, expect: "can't compute", confidence: 'low' })),
];

export interface LabelledAnswer { text: string; ids: string[]; note: string }

export const CORRECT_ANSWERS: LabelledAnswer[] = [
  { ids: ['overdue_total'], note: 'indian grouping', text: 'Overdue dues are ₹18,02,500 as of 2026-10-16.' },
  { ids: ['overdue_total'], note: 'lakh rounding', text: 'About ₹18 lakh is overdue.' },
  { ids: ['overdue_total'], note: 'decimal lakh', text: 'Rs 18.03 lakh overdue hai.' },
  { ids: ['overdue_total'], note: 'Rs prefix', text: 'Total overdue: Rs. 18,02,500.' },
  { ids: ['overdue_total', 'overdue_count'], note: 'two values', text: '3 invoices are overdue, totalling ₹18,02,500.' },
  { ids: ['overdue_count'], note: 'hinglish', text: '16 Oct tak 3 invoice overdue hain.' },
  { ids: ['overdue_share'], note: 'percent', text: '80.0% of open dues are overdue.' },
  { ids: ['overdue_share'], note: 'rounded percent', text: 'Lagbhag 80 percent dues overdue hain.' },
  { ids: ['overdue_share', 'overdue_total'], note: 'two values', text: 'Overdue ₹18,02,500, yaani 80% open dues.' },
  { ids: ['paid_in_range'], note: 'indian grouping', text: 'You received ₹5,40,000 from 2026-10-01 to 2026-10-16.' },
  { ids: ['paid_in_range'], note: 'lakh', text: 'Aapko 5.4 lakh rupaye mile.' },
  { ids: ['paid_in_range'], note: 'k unit', text: 'Collections were ₹540k.' },
  { ids: ['inquiries_in_range'], note: 'count', text: 'You got 12 new inquiries.' },
  { ids: ['inquiries_in_range', 'inquiries_closed'], note: 'two counts', text: '12 inquiries aayi, jinme se 4 close hui.' },
  { ids: ['inquiries_closed'], note: 'count', text: '4 inquiries were closed from 1 Oct to 16 Oct.' },
  { ids: ['active_listings'], note: 'count', text: 'Aapke 7 active listing hain.' },
  { ids: ['active_listings'], note: 'decimal count form', text: 'You have 7 active listings right now.' },
  { ids: ['overdue_total', 'paid_in_range'], note: 'two money', text: 'Received ₹5,40,000 but ₹18,02,500 is still overdue.' },
  { ids: ['overdue_total'], note: 'crore-free large', text: 'Overdue is INR 1802500.' },
  { ids: ['overdue_count', 'overdue_share'], note: 'count and percent', text: '3 invoices, 80.0% of open dues.' },
];

export const WRONG_ANSWERS: LabelledAnswer[] = [
  // invented number
  { ids: ['overdue_total'], note: 'invented', text: 'Overdue is ₹18,02,500 across 9 invoices.' },
  { ids: ['overdue_count'], note: 'invented', text: '5 invoices are overdue.' },
  { ids: ['paid_in_range'], note: 'invented', text: 'You received ₹7,25,000 this period.' },
  { ids: ['inquiries_in_range'], note: 'invented', text: 'You got 15 new inquiries.' },
  { ids: ['active_listings'], note: 'invented', text: 'You have 8 active listings.' },
  // wrong unit
  { ids: ['overdue_count'], note: 'count as rupees', text: '₹3 is overdue.' },
  { ids: ['overdue_total'], note: 'rupees as count', text: '18,02,500 invoices are overdue.' },
  { ids: ['inquiries_in_range'], note: 'count as lakh', text: 'You got 12 lakh inquiries.' },
  { ids: ['overdue_share'], note: 'percent as rupees', text: 'Overdue share is Rs 80.' },
  { ids: ['paid_in_range'], note: 'rupees as percent', text: 'You received 5.4% of dues.' },
  // wrong percentage
  { ids: ['overdue_share'], note: 'percent off', text: '85% of open dues are overdue.' },
  { ids: ['overdue_share'], note: 'percent off decimal', text: '80.5% of dues are overdue.' },
  { ids: ['overdue_share'], note: 'percent tenfold', text: 'Overdue share is 8%.' },
  { ids: ['overdue_share'], note: 'percent inverted', text: '20% of dues are overdue.' },
  { ids: ['overdue_share', 'overdue_total'], note: 'invented derived', text: 'Overdue ₹18,02,500, up 25% from last month.' },
  // off by a lakh / unit scale
  { ids: ['overdue_total'], note: 'minus a lakh', text: 'Overdue dues are ₹17,02,500.' },
  { ids: ['overdue_total'], note: 'crore for lakh', text: 'About ₹1.8 crore is overdue.' },
  { ids: ['overdue_total'], note: 'lakh decimal slip', text: 'Overdue is 28.02 lakh.' },
  { ids: ['paid_in_range'], note: 'plus a lakh', text: 'You received ₹6,40,000.' },
  { ids: ['paid_in_range'], note: 'k vs lakh', text: 'Collections were ₹54 lakh.' },
];
