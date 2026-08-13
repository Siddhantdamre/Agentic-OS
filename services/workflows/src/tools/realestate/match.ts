/**
 * Structured listing filters. Never invent rows. Unknown listPrice cannot
 * match a maxPrice filter (we do not guess).
 */

import type { ListingFilters, ListingRecord, ListingStatus } from './types.js';
import { isListingStatus } from './types.js';

const SEARCHABLE: ReadonlySet<ListingStatus> = new Set(['active', 'under_offer', 'stale']);

/** Parse INR shorthand (1.2 Cr, 80 L) or a plain number. Returns null if unknown. */
export function parseBudget(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const text = String(raw).trim().toLowerCase().replace(/,/g, '');
  if (!text) return null;
  const cr = text.match(/^([\d.]+)\s*(cr|crore)s?$/);
  if (cr) return Math.round(parseFloat(cr[1]) * 10_000_000);
  const lakh = text.match(/^([\d.]+)\s*(l|lac|lakh)s?$/);
  if (lakh) return Math.round(parseFloat(lakh[1]) * 100_000);
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function parseBhk(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  const text = String(raw || '').trim();
  const m = text.match(/(\d+)\s*bhk/i) || text.match(/^(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function norm(value: string | null | undefined): string {
  return (value || '').trim().toLowerCase();
}

function localityHit(row: ListingRecord, needle: string): boolean {
  const n = norm(needle);
  if (!n) return true;
  return norm(row.locality).includes(n) || norm(row.city).includes(n);
}

export function matchListings(rows: ListingRecord[], filters: ListingFilters): ListingRecord[] {
  const statuses = filters.status && filters.status.length > 0 ? new Set(filters.status) : SEARCHABLE;
  return rows.filter((row) => {
    if (!statuses.has(row.status)) return false;
    if (filters.bhk != null && row.bhk !== filters.bhk) return false;
    if (filters.locality && !localityHit(row, filters.locality)) return false;
    if (filters.city && norm(row.city) !== norm(filters.city) && !localityHit(row, filters.city)) return false;
    if (filters.maxPrice != null) {
      if (row.listPrice == null) return false;
      if (row.listPrice > filters.maxPrice) return false;
    }
    return true;
  });
}

export function listingFromSheetRow(
  orgId: string,
  header: string[],
  values: unknown[],
  source = 'sheets'
): ListingRecord | null {
  const map: Record<string, string> = {};
  header.forEach((h, i) => {
    map[norm(h).replace(/\s+/g, '_')] = values[i] == null ? '' : String(values[i]);
  });
  const sourceRef = map.id || map.source_ref || map.code || map.listing_id;
  if (!sourceRef) return null;
  const statusRaw = map.status || 'active';
  const status: ListingStatus = isListingStatus(statusRaw) ? statusRaw : 'active';
  const priceRaw = map.list_price || map.price || map.asking_price;
  return {
    id: '',
    orgId,
    source,
    sourceRef,
    title: map.title || map.name || null,
    locality: map.locality || map.area || map.neighborhood || null,
    city: map.city || null,
    bhk: parseBhk(map.bhk || map.beds),
    listPrice: parseBudget(priceRaw),
    currency: map.currency || 'INR',
    reraId: map.rera_id || map.rera || null,
    status,
    lastSourceSyncAt: new Date().toISOString(),
  };
}

export function publicListing(row: ListingRecord): Record<string, unknown> {
  return {
    id: row.id || row.sourceRef,
    source: row.source,
    sourceRef: row.sourceRef,
    title: row.title,
    locality: row.locality,
    city: row.city,
    bhk: row.bhk,
    list_price: row.listPrice,
    currency: row.currency,
    rera_id: row.reraId,
    status: row.status,
    last_source_sync_at: row.lastSourceSyncAt,
  };
}
