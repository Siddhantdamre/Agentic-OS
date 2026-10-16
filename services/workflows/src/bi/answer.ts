/**
 * Pure templating: question + computed values -> answer text. No model, no
 * guessing. If the question does not map cleanly to one computed metric the
 * answer says so and has low confidence.
 */
import { ComputedValue, formatInr, formatPercent } from './numbers.js';

export interface Answer {
  text: string;
  showWork: { label: string; value: string; query: string }[];
  confidence: 'high' | 'medium' | 'low';
  caveats: string[];
}

const HINGLISH = /\b(kitn[aei]|hai|hain|mera|meri|mere|batao|bataiye|dikhao|kya|vasool|udhaar|udhar|baaki|baki|bakaya|hafte|hafta|mahine|mahina|kul|aaye|aaya|mile|mila|abhi)\b/i;
const TIME_WORDS = /\b(last|previous|yesterday|today|tomorrow|month|week|year|quarter|pichhl\w*|pichle|kal|aaj|mahin\w*|hafte|hafta|saal)\b/i;

type Resolved = string | 'ambiguous' | null;

export function resolveMetric(q: string): Resolved {
  const dues = /overdue|baaki|baki|bakaya|outstanding|udhaar|udhar|unpaid|late payments?/.test(q);
  const paid = /\bpaid\b|received|collected|collection|vasool|paise (mile|mila|aaye)|\bpayments? (mili|mila|aayi|aaya)/.test(q);
  const inq = /inquir|enquir|\bleads?\b|queries/.test(q);
  const listing = /listing|propert|\bflats?\b/.test(q);
  const topics = [dues, paid, inq, listing].filter(Boolean).length;
  if (topics === 0) return null;
  if (topics > 1) return 'ambiguous';
  if (dues) {
    if (/percent|%|pratishat|share|hissa|fraction/.test(q)) return 'overdue_share';
    if (/how many|number of|count|kitne (invoice|bill|party|parties|customer|log)|kitni (invoice|bill)/.test(q)) return 'overdue_count';
    return 'overdue_total';
  }
  if (paid) return 'paid_in_range';
  if (inq) return /closed|\bclose\b|\bwon\b|deal|band/.test(q) ? 'inquiries_closed' : 'inquiries_in_range';
  return 'active_listings';
}

const span = (c: ComputedValue, hi: boolean) => {
  const p = c.period || {};
  if (p.asOf) return hi ? `${p.asOf} tak` : `as of ${p.asOf}`;
  if (p.from && p.to) return hi ? `${p.from} se ${p.to} tak` : `from ${p.from} to ${p.to}`;
  return '';
};

type Fmt = (v: string, s: string) => string;
const TEMPLATES: Record<string, { en: Fmt; hi: Fmt }> = {
  overdue_total: { en: (v, s) => `Overdue dues are ${v} ${s}.`, hi: (v, s) => `${s} aapke overdue dues ${v} hain.` },
  overdue_count: { en: (v, s) => `${v} invoices are overdue ${s}.`, hi: (v, s) => `${s} ${v} invoice overdue hain.` },
  overdue_share: { en: (v, s) => `${v} of your open dues are overdue ${s}.`, hi: (v, s) => `${s} aapke open dues ka ${v} overdue hai.` },
  paid_in_range: { en: (v, s) => `You received ${v} ${s}.`, hi: (v, s) => `${s} aapko ${v} mile.` },
  inquiries_in_range: { en: (v, s) => `You got ${v} new inquiries ${s}.`, hi: (v, s) => `${s} ${v} nayi inquiry aayi.` },
  inquiries_closed: { en: (v, s) => `${v} inquiries were closed ${s}.`, hi: (v, s) => `${s} ${v} inquiry close hui.` },
  active_listings: { en: (v) => `You have ${v} active listings.`, hi: (v) => `Aapke ${v} active listing hain.` },
};

const CAVEATS: Record<string, string> = {
  overdue_total: 'Counts dues marked open and past their due date; disputed dues are left out.',
  overdue_count: 'Counts dues marked open and past their due date; disputed dues are left out.',
  overdue_share: 'Share of open dues by amount; disputed and paid dues are left out.',
  paid_in_range: 'Only dues marked paid with a payment date in the period.',
  inquiries_in_range: 'Excludes deleted inquiries. Dates are calendar dates, not IST cut-offs.',
  inquiries_closed: 'Inquiries now closed whose last update falls in the period.',
  active_listings: 'Listings currently marked active.',
};

const show = (c: ComputedValue) => (c.unit === 'inr' ? formatInr(c.value) : c.unit === 'percent' ? formatPercent(c.value) : String(c.value));

function decline(hi: boolean, why: string): Answer {
  const text = hi
    ? "Yeh main abhi compute nahi kar sakta. I can't compute that yet."
    : "I can't compute that yet.";
  return { text, showWork: [], confidence: 'low', caveats: [why] };
}

export function buildAnswer(question: string, computed: ComputedValue[]): Answer {
  const q = String(question || '').toLowerCase();
  const hi = HINGLISH.test(q);
  const id = resolveMetric(q);
  if (id === null) return decline(hi, 'No metric matches this question. Supported: overdue dues, payments received, inquiries, active listings.');
  if (id === 'ambiguous') return decline(hi, 'The question mixes more than one topic. Ask about one thing at a time.');
  const c = computed.find((v) => v.id === id);
  if (!c || !Number.isFinite(c.value)) return decline(hi, `Metric ${id} has no computed value for this question.`);

  const caveats = [CAVEATS[id]];
  let confidence: Answer['confidence'] = 'high';
  if (!c.query) { confidence = 'medium'; caveats.push('No query was recorded for this number, so it cannot be re-checked.'); }
  if (TIME_WORDS.test(q) && id !== 'active_listings') {
    confidence = 'medium';
    caveats.push(`Showing ${span(c, false) || 'the computed period'}; time words in your question were not interpreted.`);
  }
  if (c.value === 0) { confidence = 'medium'; caveats.push('The result is zero; check that the data is connected and up to date.'); }

  const value = show(c);
  const t = TEMPLATES[id];
  return {
    text: (hi ? t.hi : t.en)(value, span(c, hi)).replace(/\s+\./, '.').replace(/\s{2,}/g, ' '),
    showWork: [{ label: c.label, value, query: c.query || '' }],
    confidence,
    caveats,
  };
}
