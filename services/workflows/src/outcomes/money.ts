/**
 * What the AI was worth, in money — and what it is NOT allowed to claim.
 *
 * WHY THIS IS SEPARATE AND PURE
 * "84% resolved without a human" is a good number. "₹4,20,000 of quotes went
 * out without anyone stepping in, 11 viewings booked, 6 payments received" is
 * a different conversation and a different price. It is also the single
 * easiest number in this product to get flatteringly wrong, and the most
 * damaging when it is: a business that cannot trace a money figure back to
 * real rows stops believing every other number on the page.
 *
 * So the arithmetic lives here, with no database and no clock, and every edge
 * case below is a unit test rather than something hoped for in SQL.
 *
 * THE RULE THAT MATTERS MOST
 * Amounts in different currencies are NEVER added. ₹ + $ is not a number, and
 * a single "total value" across currencies is a figure that looks precise and
 * means nothing. Everything is grouped by currency and reported per currency,
 * even when that makes the headline less impressive.
 */

export type ValueOutcomeKind = 'meeting_booked' | 'payment_received' | 'deal_closed';

export interface ValueOutcomeRow {
  kind: ValueOutcomeKind;
  /** null when the outcome carried no money — a booked meeting usually does not. */
  amount: number | null;
  currency: string | null;
  /** True when a person spoke in the conversation this outcome belongs to. */
  humanInvolved: boolean;
}

export interface CurrencyTotals {
  currency: string;
  /** Money on conversations no person touched. */
  withoutHuman: number;
  /** Money on conversations a person did touch. */
  withHuman: number;
  total: number;
}

export interface MoneySummary {
  counts: {
    meetingsBooked: number;
    paymentsReceived: number;
    dealsClosed: number;
    /** Outcomes carrying an amount, and those that did not. */
    withAmount: number;
    withoutAmount: number;
  };
  /** One row per currency, sorted by total value. Never summed together. */
  byCurrency: CurrencyTotals[];
}

/**
 * Normalise a currency code.
 *
 * "inr", "INR " and "Inr" are one currency, and letting them become three
 * rows would split a business's own revenue across near-duplicate lines that
 * each look too small.
 */
function normaliseCurrency(raw: string | null): string | null {
  const c = (raw || '').trim().toUpperCase();
  return c === '' ? null : c;
}

/**
 * Is this a real money amount?
 *
 * null and NaN both mean "this outcome carried no money", which is NOT the
 * same as zero. A meeting booked for free is worth counting and contributes
 * nothing to revenue; treating its missing amount as 0 would be harmless here
 * but hides the distinction the caller needs to explain the number.
 */
function isAmount(v: number | null): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function summariseMoney(rows: ValueOutcomeRow[]): MoneySummary {
  const counts = {
    meetingsBooked: 0,
    paymentsReceived: 0,
    dealsClosed: 0,
    withAmount: 0,
    withoutAmount: 0,
  };
  const byCurrency = new Map<string, CurrencyTotals>();

  for (const row of rows || []) {
    switch (row.kind) {
      case 'meeting_booked': counts.meetingsBooked++; break;
      case 'payment_received': counts.paymentsReceived++; break;
      case 'deal_closed': counts.dealsClosed++; break;
      default: break;
    }

    const currency = normaliseCurrency(row.currency);
    // An amount with no currency cannot be reported: "4,20,000" of what? It is
    // counted as unvalued rather than guessed at, because guessing the
    // currency of somebody's revenue is not a defensible default.
    if (!isAmount(row.amount) || !currency) {
      counts.withoutAmount++;
      continue;
    }
    counts.withAmount++;

    const entry = byCurrency.get(currency)
      || { currency, withoutHuman: 0, withHuman: 0, total: 0 };
    if (row.humanInvolved) entry.withHuman += row.amount;
    else entry.withoutHuman += row.amount;
    entry.total += row.amount;
    byCurrency.set(currency, entry);
  }

  // Rounded at the edge, not during accumulation, so a long tail of small
  // amounts does not drift. Two decimals: these are money, not floats.
  const round = (n: number) => Math.round(n * 100) / 100;

  return {
    counts,
    byCurrency: [...byCurrency.values()]
      .map((c) => ({
        currency: c.currency,
        withoutHuman: round(c.withoutHuman),
        withHuman: round(c.withHuman),
        total: round(c.total),
      }))
      .sort((a, b) => b.total - a.total || a.currency.localeCompare(b.currency)),
  };
}

/**
 * The share of value that needed nobody — per currency, never across.
 *
 * Returns null rather than 0 when there is no money in that currency at all.
 * "0% of value was handled autonomously" and "no money was recorded" are
 * opposite statements about a business, and rendering the second as the first
 * would be the most visible lie this product could tell.
 */
export function autonomousValuePct(totals: CurrencyTotals): number | null {
  if (totals.total === 0) return null;
  return Math.round((totals.withoutHuman / totals.total) * 1000) / 10;
}
