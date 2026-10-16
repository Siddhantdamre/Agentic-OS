import { checkPublicUrl } from '../tools/safe-url.js';

export interface Claim {
  /** The sentence as it appears in the report. */
  text: string;
  sourceUrls: string[];
  /** Verbatim support copied from the source page. */
  quote: string;
  /** Optional structure used by contradiction detection. */
  subject?: string;
  metric?: string;
  value?: number | string;
  unit?: string;
}

export interface Source {
  url: string;
  /** Fetched page text (already truncated by the fetch budget). */
  text: string;
  title?: string;
  publishedAt?: string;
}

export interface DraftReport {
  text: string;
  claims: Claim[];
}

export type UnsupportedReason = 'no_claim' | 'no_quote' | 'no_safe_source' | 'quote_not_in_source' | 'quote_misses_figures';

export interface UnsupportedClaim {
  sentence: string;
  reason: UnsupportedReason;
}

export interface SupportedSentence {
  sentence: string;
  sourceUrls: string[];
}

export interface CitationCheck {
  unsupported: UnsupportedClaim[];
  supported: SupportedSentence[];
}

/** Lowercase, drop thousands separators and punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[^\p{L}\p{N}.%$]+/gu, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/(?<!\d)\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitSentences(text: string): string[] {
  return String(text ?? '')
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'(\[$])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const MONTHS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;

/** Sentence needs a source: it has a number, date, price, or a named entity mid-sentence. */
export function isFactual(sentence: string): boolean {
  const s = sentence.replace(/^\s*(?:[-*•#>]+|\d+[.)])\s*/, '').replace(/\[\d+\]/g, '');
  if (/\d/.test(s) || /[$€£₹]/.test(s) || MONTHS.test(s)) return true;
  const words = s.split(/\s+/).slice(1);
  return words.some((w) => /^[A-Z][a-z]{2,}/.test(w.replace(/^["'(]/, '')));
}

function figures(s: string): string[] {
  return normalizeText(s).match(/\d+(?:\.\d+)?/g) ?? [];
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).toString() === new URL(b).toString();
  } catch {
    return a === b;
  }
}

function isSafe(url: string): boolean {
  try {
    checkPublicUrl(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every factual sentence of the report must be backed by a claim whose quote
 * literally appears (after normalisation) in a fetched, public source, and the
 * quote must carry every figure the sentence states.
 */
export function checkCitations(report: DraftReport, sources: Source[]): CitationCheck {
  const unsupported: UnsupportedClaim[] = [];
  const supported: SupportedSentence[] = [];
  for (const sentence of splitSentences(report.text)) {
    if (!isFactual(sentence)) continue;
    const ns = normalizeText(sentence.replace(/\[\d+\]/g, ''));
    const matching = report.claims.filter((c) => {
      const nc = normalizeText(c.text);
      return nc.length > 0 && (ns.includes(nc) || nc.includes(ns));
    });
    if (matching.length === 0) {
      unsupported.push({ sentence, reason: 'no_claim' });
      continue;
    }
    const need = figures(sentence);
    let reason: UnsupportedReason = 'no_quote';
    const urls: string[] = [];
    for (const c of matching) {
      const quote = normalizeText(c.quote);
      if (!quote) continue;
      reason = 'no_safe_source';
      for (const url of c.sourceUrls ?? []) {
        if (!isSafe(url)) continue;
        const src = sources.find((s) => sameUrl(s.url, url));
        if (!src) continue;
        if (reason === 'no_safe_source') reason = 'quote_not_in_source';
        if (!normalizeText(src.text).includes(quote)) continue;
        const have = new Set(figures(c.quote));
        if (!need.every((n) => have.has(n))) {
          reason = 'quote_misses_figures';
          continue;
        }
        urls.push(src.url);
      }
    }
    if (urls.length) supported.push({ sentence, sourceUrls: [...new Set(urls)] });
    else unsupported.push({ sentence, reason });
  }
  return { unsupported, supported };
}
