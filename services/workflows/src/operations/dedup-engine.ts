/**
 * Fuzzy company dedup (P3-DEDUP-1).
 * Score = 0.5 name-trgm + 0.3 domain + 0.2 phone.
 * ≥0.85 merge, 0.60–0.85 quarantine, else create.
 */
import type { PoolClient } from 'pg';
import { isUndefinedTable } from '../db.js';
import { DEDUP_MERGE_MIN, DEDUP_QUARANTINE_MIN } from './types.js';

export type DedupDecision = 'merge' | 'quarantine' | 'create';

export interface DedupCandidate {
  id?: string;
  name: string;
  domain?: string | null;
  phone?: string | null;
}

export interface DedupScore {
  name: number;
  domain: number;
  phone: number;
  total: number;
  decision: DedupDecision;
  candidate?: DedupCandidate;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|tech|technologies|technology|solutions|group)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDomain(value: string | null | undefined): string {
  if (!value) return '';
  return value.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim();
}

function normalizePhone(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\D+/g, '');
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

export function trigramSimilarity(a: string, b: string): number {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;
  const aGrams = trigrams(left);
  const bGrams = trigrams(right);
  let overlap = 0;
  for (const gram of aGrams) {
    if (bGrams.has(gram)) overlap += 1;
  }
  const denom = aGrams.size + bGrams.size - overlap;
  return denom === 0 ? 0 : overlap / denom;
}

function domainScore(a?: string | null, b?: string | null): number {
  const left = normalizeDomain(a);
  const right = normalizeDomain(b);
  if (!left || !right) return 0;
  return left === right ? 1 : 0;
}

function phoneScore(a?: string | null, b?: string | null): number {
  const left = normalizePhone(a);
  const right = normalizePhone(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return longer.endsWith(shorter) && shorter.length >= 7 ? 1 : 0;
}

export function decideDedup(score: number): DedupDecision {
  if (score >= DEDUP_MERGE_MIN) return 'merge';
  if (score >= DEDUP_QUARANTINE_MIN) return 'quarantine';
  return 'create';
}

export function scoreAgainst(incoming: DedupCandidate, existing: DedupCandidate): DedupScore {
  const name = trigramSimilarity(incoming.name, existing.name);
  const domain = domainScore(incoming.domain, existing.domain);
  const phone = phoneScore(incoming.phone, existing.phone);
  const total = 0.5 * name + 0.3 * domain + 0.2 * phone;
  return {
    name,
    domain,
    phone,
    total,
    decision: decideDedup(total),
    candidate: existing,
  };
}

export function pickDedup(incoming: DedupCandidate, existing: DedupCandidate[]): DedupScore {
  let best: DedupScore = { name: 0, domain: 0, phone: 0, total: 0, decision: 'create' };
  for (const candidate of existing) {
    const scored = scoreAgainst(incoming, candidate);
    if (scored.total > best.total) best = scored;
  }
  return best;
}

export async function persistAmbiguousDuplicate(
  client: PoolClient,
  orgId: string,
  incoming: DedupCandidate,
  match: DedupScore
): Promise<{ queued: boolean }> {
  if (match.decision !== 'quarantine') return { queued: false };
  try {
    await client.query(
      `INSERT INTO ambiguous_duplicate_reviews (org_id, incoming, match_id, score, status)
       VALUES ($1, $2::jsonb, $3, $4, 'pending')`,
      [orgId, JSON.stringify(incoming), match.candidate?.id ?? null, match.total]
    );
    return { queued: true };
  } catch (err) {
    if (isUndefinedTable(err)) return { queued: false };
    throw err;
  }
}
