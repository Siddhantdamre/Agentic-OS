import type { Claim } from './claims.js';
import { normalizeText } from './claims.js';

export interface Position {
  value: number | string;
  unit?: string;
  claims: string[];
  sourceUrls: string[];
}

export interface Contradiction {
  subject: string;
  metric: string;
  positions: Position[];
}

export interface ContradictionOptions {
  /** Relative tolerance; values within it are the same number. Default 2%. */
  tolerance?: number;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function close(a: number, b: number, tol: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 || Math.abs(a - b) / scale <= tol;
}

function sameValue(a: Claim, b: Claim, tol: number): boolean {
  const na = num(a.value);
  const nb = num(b.value);
  if (na !== null && nb !== null) return close(na, nb, tol);
  return normalizeText(String(a.value)) === normalizeText(String(b.value));
}

function disjoint(a: string[], b: string[]): boolean {
  return !a.some((u) => b.includes(u));
}

/**
 * Same subject and metric, different values, backed by different sources.
 * Numbers within tolerance are agreement. Both sides are returned so the
 * reader sees the disagreement instead of one silently winning.
 */
export function findContradictions(claims: Claim[], options: ContradictionOptions = {}): Contradiction[] {
  const tol = options.tolerance ?? 0.02;
  const groups = new Map<string, Claim[]>();
  for (const c of claims) {
    if (!c.subject || !c.metric || c.value === undefined || c.value === null || c.value === '') continue;
    const unit = c.unit ? normalizeText(c.unit) : '';
    const key = `${normalizeText(c.subject)}|${normalizeText(c.metric)}|${unit}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
  }
  const out: Contradiction[] = [];
  for (const group of groups.values()) {
    const clusters: Claim[][] = [];
    for (const c of group) {
      const home = clusters.find((cl) => sameValue(cl[0], c, tol));
      if (home) home.push(c);
      else clusters.push([c]);
    }
    if (clusters.length < 2) continue;
    const conflict = clusters.some((a, i) =>
      clusters.slice(i + 1).some((b) => a.some((x) => b.some((y) => disjoint(x.sourceUrls ?? [], y.sourceUrls ?? [])))),
    );
    if (!conflict) continue;
    out.push({
      subject: group[0].subject!,
      metric: group[0].metric!,
      positions: clusters.map((cl) => ({
        value: cl[0].value as number | string,
        ...(cl[0].unit ? { unit: cl[0].unit } : {}),
        claims: cl.map((c) => c.text),
        sourceUrls: [...new Set(cl.flatMap((c) => c.sourceUrls ?? []))],
      })),
    });
  }
  return out;
}
