'use strict';

/**
 * Listing filter helper for pack goldens. Mirrors
 * services/workflows/src/tools/realestate/match.ts — never invents rows.
 */

function parseBudget(raw) {
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

function parseBhk(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  const text = String(raw || '').trim();
  const m = text.match(/(\d+)\s*bhk/i) || text.match(/^(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function localityHit(row, needle) {
  const n = norm(needle);
  if (!n) return true;
  return norm(row.locality).includes(n) || norm(row.city).includes(n);
}

const SEARCHABLE = new Set(['active', 'under_offer', 'stale']);

function matchListings(rows, filters) {
  return (rows || []).filter((row) => {
    if (!SEARCHABLE.has(row.status || 'active')) return false;
    if (filters.bhk != null && row.bhk !== filters.bhk) return false;
    if (filters.locality && !localityHit(row, filters.locality)) return false;
    if (filters.maxPrice != null) {
      if (row.listPrice == null) return false;
      if (row.listPrice > filters.maxPrice) return false;
    }
    return true;
  });
}

function searchOutput(rows, filters) {
  const matched = matchListings(rows, filters);
  return {
    status: 'executed',
    message:
      matched.length === 0
        ? 'No matching listings in the connected sheet/projection. Will not invent inventory.'
        : `Matched ${matched.length} listing(s) from source rows only.`,
    data: {
      connected: true,
      source: 'sheets',
      filters,
      listings: matched.map((row) => ({
        id: row.id || row.sourceRef,
        source: row.source,
        sourceRef: row.sourceRef,
        title: row.title,
        locality: row.locality,
        city: row.city,
        bhk: row.bhk,
        list_price: row.listPrice,
        currency: row.currency,
        status: row.status,
      })),
      matchCount: matched.length,
      invented: false,
    },
  };
}

function applyChargeEvent(charge, attempt, nowIso) {
  switch (attempt.kind) {
    case 'tenant_claim':
      return { ...charge, claimedPaidAt: nowIso, status: charge.status };
    case 'psp_webhook':
      return {
        ...charge,
        status: 'closed',
        closedReason: 'psp_webhook',
        pspPaymentId: attempt.pspPaymentId,
      };
    case 'human_confirm':
      return { ...charge, status: 'closed', closedReason: 'human_confirm' };
    default:
      return charge;
  }
}

const FAIR_HOUSING = [
  /\bperfect for\s+(christian|hindu|muslim|jewish|sikh)s?\b/i,
  /\bperfect for\s+(families|singles|couples)\b/i,
  /\bno\s+(kids|children|child)\b/i,
  /\badults[-\s]?only\b/i,
  /\bno\s+section\s*8\b/i,
];

function validateOutboundDraft(draft, intent) {
  const text = String(draft || '');
  if (FAIR_HOUSING.some((re) => re.test(text))) {
    return { allow: false, policy: 'fair_housing', reason: 'blocked by policy: fair housing' };
  }
  if (/\bguaranteed\b[\s\S]{0,24}\b(returns?|yield|rent|\d+\s*%)\b/i.test(text)) {
    return { allow: false, policy: 'legal_promise', reason: 'blocked by policy: legal promise' };
  }
  const looksLikeInAd =
    intent === 'publish' &&
    /\b(for\s+sale|for\s+rent|2bhk|3bhk|listing)\b/i.test(text) &&
    /\b(mumbai|pune|bengaluru|bangalore|india|koramangala)\b/i.test(text);
  if (looksLikeInAd && !/\brera\b/i.test(text)) {
    return { allow: false, policy: 'rera', reason: 'blocked by policy: RERA missing' };
  }
  return { allow: true, policy: 'ok', reason: 'heuristic pass' };
}

module.exports = {
  parseBudget,
  parseBhk,
  matchListings,
  searchOutput,
  applyChargeEvent,
  validateOutboundDraft,
};
