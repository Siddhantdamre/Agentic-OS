/**
 * Claim extraction and verification for the "ask your numbers" analyst.
 *
 * Rule: an answer may only state a number that was computed. Every number,
 * rupee amount, percentage and date in the text must match a ComputedValue
 * of the same kind. Money only matches rupee values, percentages only
 * percentage values, bare numbers only counts. Anything else is listed as
 * unsupported, so a wrong unit is as visible as a wrong number.
 */

export type Unit = 'inr' | 'count' | 'percent';

export interface ComputedValue {
  id: string;
  label: string;
  unit: Unit;
  value: number;
  /** The parameterised SQL that produced it, shown to the owner as "show work". */
  query?: string;
  /** Dates this value is stated for. An answer may repeat these dates. */
  period?: { asOf?: string; from?: string; to?: string };
}

export type ClaimKind = 'money' | 'percent' | 'number' | 'date';

export interface Claim {
  kind: ClaimKind;
  raw: string;
  /** Rupees for money, percent points for percent, plain number otherwise. */
  value: number;
  /** Allowed distance: half a unit of the last digit the answer wrote. */
  tol: number;
  /** For dates: YYYY-MM-DD, or MM-DD when the answer gave no year. */
  date?: string;
}

const SCALE: Record<string, number> = {
  k: 1e3, thousand: 1e3, hazaar: 1e3, hazar: 1e3,
  lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5,
  crore: 1e7, crores: 1e7, cr: 1e7,
};
const UNIT_WORDS = 'lakhs?|lacs?|crores?|cr|k|hazaar|hazar|thousand';
const NUM = '\\d{1,3}(?:,\\d{2,3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const parse = (s: string) => Number(s.replace(/,/g, ''));
const decimals = (s: string) => (s.split('.')[1] || '').length;
const half = (s: string, scale = 1) => 0.5 * Math.pow(10, -decimals(s)) * scale + 1e-9;
const pad2 = (n: number | string) => String(n).padStart(2, '0');

/** Every number, rupee amount, percentage and date the text states. Never throws. */
export function extractClaims(answerText: string): Claim[] {
  const claims: Claim[] = [];
  let rest = String(answerText ?? '');
  const take = (re: RegExp, make: (m: RegExpExecArray) => Claim | null) => {
    rest = rest.replace(re, (...args) => {
      const groups = args.slice(0, -2) as string[];
      const m = Object.assign(groups, { index: args[args.length - 2] }) as unknown as RegExpExecArray;
      const claim = make(m);
      if (claim) claims.push(claim);
      return ' '.repeat(String(args[0]).length);
    });
  };

  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => ({ kind: 'date', raw: m[0], value: 0, tol: 0, date: `${m[1]}-${m[2]}-${m[3]}` }));
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})[a-z]*\\.?(?:,?\\s+(\\d{4}))?\\b`, 'gi'),
    (m) => {
      const mm = pad2(MONTHS.indexOf(m[2].toLowerCase()) + 1);
      return { kind: 'date', raw: m[0], value: 0, tol: 0, date: `${m[3] ? m[3] + '-' : ''}${mm}-${pad2(m[1])}` };
    });
  take(new RegExp(`(${NUM})\\s*(?:%|percent\\b|pratishat\\b|per\\s?cent\\b)`, 'gi'),
    (m) => ({ kind: 'percent', raw: m[0], value: parse(m[1]), tol: half(m[1]) }));
  take(new RegExp(`(?:₹|\\brs\\b\\.?|\\binr\\b|\\brupees?\\b|\\brupaye\\b)\\s*(${NUM})(?:\\s*(${UNIT_WORDS})\\b)?`, 'gi'),
    (m) => money(m[0], m[1], m[2]));
  take(new RegExp(`(${NUM})\\s*(${UNIT_WORDS})\\b`, 'gi'), (m) => money(m[0], m[1], m[2]));
  take(new RegExp(`(${NUM})\\s*(?:rupees?|rupaye|rs)\\b`, 'gi'), (m) => money(m[0], m[1], undefined));
  take(new RegExp(NUM, 'g'), (m) => ({ kind: 'number', raw: m[0], value: parse(m[0]), tol: half(m[0]) }));

  return claims;
}

function money(raw: string, n: string, unit?: string): Claim {
  const scale = unit ? SCALE[unit.toLowerCase()] : 1;
  return { kind: 'money', raw, value: parse(n) * scale, tol: half(n, scale) };
}

const UNIT_OF: Record<string, Unit> = { money: 'inr', percent: 'percent', number: 'count' };

function supported(c: Claim, computed: ComputedValue[]): boolean {
  if (c.kind === 'date') {
    const dates = computed.flatMap((v) => [v.period?.asOf, v.period?.from, v.period?.to]).filter(Boolean) as string[];
    return dates.some((d) => (c.date!.length === 5 ? d.slice(5) === c.date : d === c.date));
  }
  return computed.some((v) => v.unit === UNIT_OF[c.kind] && Number.isFinite(v.value)
    && Math.abs(Math.abs(v.value) - c.value) <= c.tol);
}

/** ok only when every claim in the answer matches a computed value of the same kind. */
export function verifyAnswer(answerText: string, computed: ComputedValue[]): { ok: boolean; unsupported: Claim[] } {
  const unsupported = extractClaims(answerText).filter((c) => !supported(c, computed));
  return { ok: unsupported.length === 0, unsupported };
}

/** 1802500 -> "₹18,02,500". Whole rupees unless the value has paise. */
export function formatInr(v: number): string {
  const neg = v < 0 ? '-' : '';
  const [whole, frac] = Math.abs(v).toFixed(Number.isInteger(v) ? 0 : 2).split('.');
  const head = whole.length > 3 ? whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3) : whole;
  return `${neg}₹${head}${frac ? '.' + frac : ''}`;
}

export const formatPercent = (v: number) => `${v.toFixed(1)}%`;
