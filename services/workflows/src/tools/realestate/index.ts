/**
 * Real-estate tools (C7 / P3). Sheets/CSV projection is SoR.
 * Search returns only stored rows. Zero matches does not invent inventory.
 */

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import type { ToolExecutionResult } from '@darex/shared-types';
import type { ToolRisk } from '../risk.js';
import type { ToolActionContext, ToolModule } from '../shared.js';
import {
  apiError,
  confirmFromRisk,
  notConnected,
  withOrgScopedClient,
} from '../shared.js';
import { googleCalendar } from '../google-calendar.js';
import { googleSheets } from '../google-sheets.js';
import { applyChargeEvent } from './charges.js';
import { validateOutboundDraft } from './compliance.js';
import { listingFromSheetRow, matchListings, parseBhk, parseBudget, publicListing } from './match.js';
import type { ChargeRecord, ListingRecord, ListingStatus } from './types.js';
import { isInquiryStatus, isListingStatus } from './types.js';

const ACTIONS = [
  'listings_search',
  'listings_get',
  'listings_sync_sheet',
  'inquiry_create',
  'inquiry_list',
  'showing_book',
  'validate_draft',
  'charge_claim_paid',
  'charge_close',
] as const;

type ReAction = (typeof ACTIONS)[number];

function riskFor(action: string): ToolRisk {
  const a = normalizeAction(action);
  switch (a) {
    case 'listings_search':
    case 'listings_get':
    case 'inquiry_list':
    case 'validate_draft':
      return 'read';
    case 'listings_sync_sheet':
    case 'inquiry_create':
    case 'charge_claim_paid':
      return 'draft';
    case 'showing_book':
      return 'send';
    case 'charge_close':
      return 'pay';
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

function normalizeAction(action: string): ReAction {
  const a = action.toLowerCase().replace(/[.-]/g, '_');
  if (a.includes('sync')) return 'listings_sync_sheet';
  if (a.includes('search') || a.includes('match')) return 'listings_search';
  if (a.includes('listings_get') || a === 'get' || a.includes('listing_get')) return 'listings_get';
  if (a.includes('inquiry_list') || a.includes('inquiries')) return 'inquiry_list';
  if (a.includes('inquiry')) return 'inquiry_create';
  if (a.includes('showing') || a.includes('book')) return 'showing_book';
  if (a.includes('validate') || a.includes('draft')) return 'validate_draft';
  if (a.includes('claim')) return 'charge_claim_paid';
  if (a.includes('close') || a.includes('paid')) return 'charge_close';
  if ((ACTIONS as readonly string[]).includes(a)) return a as ReAction;
  return 'listings_search';
}

function rowToListing(orgId: string, row: Record<string, unknown>): ListingRecord {
  const statusRaw = String(row.status || 'active');
  const status: ListingStatus = isListingStatus(statusRaw) ? statusRaw : 'active';
  const price = row.list_price;
  return {
    id: String(row.id),
    orgId,
    source: String(row.source || 'sheets'),
    sourceRef: String(row.source_ref || ''),
    title: row.title == null ? null : String(row.title),
    locality: row.locality == null ? null : String(row.locality),
    city: row.city == null ? null : String(row.city),
    bhk: row.bhk == null ? null : Number(row.bhk),
    listPrice: price == null || price === '' ? null : Number(price),
    currency: String(row.currency || 'INR'),
    reraId: row.rera_id == null ? null : String(row.rera_id),
    status,
    lastSourceSyncAt: row.last_source_sync_at
      ? new Date(String(row.last_source_sync_at)).toISOString()
      : null,
  };
}

async function loadProjection(client: PoolClient, orgId: string): Promise<ListingRecord[]> {
  const res = await client.query(
    `SELECT id, source, source_ref, title, locality, city, bhk, list_price, currency,
            rera_id, status, last_source_sync_at
       FROM re_listings
      WHERE org_id = $1`,
    [orgId]
  );
  return res.rows.map((r) => rowToListing(orgId, r as Record<string, unknown>));
}

async function writeListingMemory(
  client: PoolClient,
  orgId: string,
  listing: ListingRecord
): Promise<void> {
  const body = [
    listing.title || listing.sourceRef,
    listing.bhk != null ? `${listing.bhk}BHK` : '',
    listing.locality || '',
    listing.city || '',
    listing.listPrice != null ? `${listing.listPrice} ${listing.currency}` : 'price unknown in source',
    listing.reraId ? `RERA ${listing.reraId}` : 'RERA not in source',
    `source=${listing.source} ref=${listing.sourceRef}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const hash = createHash('sha256').update(`re.listing:${listing.id}:${body}`).digest('hex');
  await client.query(
    `INSERT INTO entity_memory (
       org_id, entity_type, entity_id, kind, title, body, source, source_ref, content_hash, metadata
     ) VALUES ($1, 're.listing', $2, 'fact', $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (org_id, source, source_ref, content_hash) DO NOTHING`,
    [
      orgId,
      listing.id || listing.sourceRef,
      listing.title || listing.sourceRef,
      body,
      listing.source,
      listing.sourceRef,
      hash,
      JSON.stringify({ list_price: listing.listPrice, invented: false }),
    ]
  );
}

async function execute(ctx: ToolActionContext): Promise<ToolExecutionResult> {
  const { payload, orgId, timestamp } = ctx;
  const action = normalizeAction(ctx.action || ctx.actionName);

  try {
    switch (action) {
      case 'listings_search':
        return await searchListings(ctx, action);
      case 'listings_get':
        return await getListing(ctx, action);
      case 'listings_sync_sheet':
        return await syncSheet(ctx, action);
      case 'inquiry_create':
        return await createInquiry(ctx, action);
      case 'inquiry_list':
        return await listInquiries(ctx, action);
      case 'showing_book':
        return await bookShowing(ctx, action);
      case 'validate_draft': {
        const intentRaw = String(payload.intent || 'send');
        const intent = intentRaw === 'publish' || intentRaw === 'sign' ? intentRaw : 'send';
        const result = validateOutboundDraft(String(payload.draft || payload.text || ''), intent);
        return {
          tool: 're',
          action,
          status: result.allow ? 'executed' : 'error',
          message: result.reason,
          data: result,
          timestamp,
        };
      }
      case 'charge_claim_paid':
      case 'charge_close':
        return await mutateCharge(ctx, action);
      default: {
        const _exhaustive: never = action;
        return apiError('re', ctx.actionName, timestamp, `Unknown re action: ${_exhaustive}`);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/re_listings|does not exist|relation/i.test(message)) {
      return apiError(
        're',
        action,
        timestamp,
        'RE tables missing — apply infra/db/migrations/015_packs.sql. Will not invent inventory.'
      );
    }
    return apiError('re', action, timestamp, message);
  }
}

async function searchListings(ctx: ToolActionContext, action: ReAction): Promise<ToolExecutionResult> {
  const { payload, orgId, timestamp } = ctx;
  const filters = {
    bhk: parseBhk(payload.bhk ?? payload.beds) ?? undefined,
    locality: typeof payload.locality === 'string' ? payload.locality : typeof payload.area === 'string' ? payload.area : undefined,
    city: typeof payload.city === 'string' ? payload.city : undefined,
    maxPrice: parseBudget(payload.maxPrice ?? payload.budget ?? payload.under) ?? undefined,
  };

  return withOrgScopedClient(orgId, async (client) => {
    let rows = await loadProjection(client, orgId);
    const spreadsheetId = payload.spreadsheetId || payload.sheetId;
    if (spreadsheetId) {
      const sheet = await googleSheets.execute({
        ...ctx,
        tool: 'google-sheets',
        action: 'sheets_read',
        actionName: 'sheets_read',
      });
      if (sheet.status === 'error' && sheet.data && (sheet.data as { connected?: boolean }).connected === false) {
        if (rows.length === 0) return sheet;
      } else if (sheet.status === 'executed') {
        const values = ((sheet.data as { rows?: unknown[][] } | null)?.rows || []) as unknown[][];
        if (values.length >= 2) {
          const header = values[0].map((c) => String(c));
          const parsed = values.slice(1)
            .map((r) => listingFromSheetRow(orgId, header, r))
            .filter((r): r is ListingRecord => Boolean(r));
          rows = parsed.map((p) => ({
            ...p,
            id: p.sourceRef,
          }));
        } else {
          rows = [];
        }
      }
    }

    const matched = matchListings(rows, filters);
    for (const listing of matched.slice(0, 7)) {
      if (listing.id) await writeListingMemory(client, orgId, listing).catch(() => undefined);
    }
    return {
      tool: 're',
      action,
      status: 'executed' as const,
      message:
        matched.length === 0
          ? 'No matching listings in the connected sheet/projection. Will not invent inventory. You can widen BHK, locality, or budget.'
          : `Matched ${matched.length} listing(s) from source rows only.`,
      data: {
        connected: true,
        source: spreadsheetId ? 'sheets' : 're_listings',
        filters,
        listings: matched.map(publicListing),
        matchCount: matched.length,
        invented: false,
      },
      timestamp,
    };
  });
}

async function getListing(ctx: ToolActionContext, action: ReAction): Promise<ToolExecutionResult> {
  const { payload, orgId, timestamp } = ctx;
  const id = String(payload.id || payload.listingId || payload.sourceRef || '').trim();
  if (!id) return apiError('re', action, timestamp, 'listing id is required');
  return withOrgScopedClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT id, source, source_ref, title, locality, city, bhk, list_price, currency,
              rera_id, status, last_source_sync_at
         FROM re_listings
        WHERE org_id = $1 AND (id::text = $2 OR source_ref = $2)
        LIMIT 1`,
      [orgId, id]
    );
    if (!res.rows[0]) {
      return {
        tool: 're',
        action,
        status: 'executed' as const,
        message: 'Listing not in this org projection. Will not invent a unit.',
        data: { listing: null, invented: false },
        timestamp,
      };
    }
    const listing = rowToListing(orgId, res.rows[0] as Record<string, unknown>);
    return {
      tool: 're',
      action,
      status: 'executed' as const,
      message: 'Listing from projection (source fields only).',
      data: { listing: publicListing(listing), invented: false },
      timestamp,
    };
  });
}

async function syncSheet(ctx: ToolActionContext, action: ReAction): Promise<ToolExecutionResult> {
  const { payload, orgId, timestamp } = ctx;
  const spreadsheetId = payload.spreadsheetId || payload.sheetId;
  if (!spreadsheetId) {
    return apiError('re', action, timestamp, 'spreadsheetId is required to sync inventory from Sheets.');
  }
  const sheet = await googleSheets.execute({
    ...ctx,
    tool: 'google-sheets',
    action: 'sheets_read',
    actionName: 'sheets_read',
    payload: { ...payload, spreadsheetId },
  });
  if (sheet.status === 'error') return sheet;
  const values = ((sheet.data as { rows?: unknown[][] } | null)?.rows || []) as unknown[][];
  if (values.length < 2) {
    return {
      tool: 're',
      action,
      status: 'executed' as const,
      message: 'Sheet has no data rows. Inventory stays empty — nothing invented.',
      data: { upserted: 0, listings: [] },
      timestamp,
    };
  }
  const header = values[0].map((c) => String(c));
  const parsed = values
    .slice(1)
    .map((r) => listingFromSheetRow(orgId, header, r))
    .filter((r): r is ListingRecord => Boolean(r));

  return withOrgScopedClient(orgId, async (client) => {
    let upserted = 0;
    const ids: string[] = [];
    for (const row of parsed) {
      const res = await client.query(
        `INSERT INTO re_listings (
           org_id, source, source_ref, title, locality, city, bhk, list_price, currency,
           rera_id, status, last_source_sync_at, payload
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12::jsonb)
         ON CONFLICT (org_id, source, source_ref) DO UPDATE SET
           title = EXCLUDED.title,
           locality = EXCLUDED.locality,
           city = EXCLUDED.city,
           bhk = EXCLUDED.bhk,
           list_price = EXCLUDED.list_price,
           currency = EXCLUDED.currency,
           rera_id = EXCLUDED.rera_id,
           status = EXCLUDED.status,
           last_source_sync_at = NOW(),
           payload = EXCLUDED.payload,
           updated_at = NOW()
         RETURNING id`,
        [
          orgId,
          row.source,
          row.sourceRef,
          row.title,
          row.locality,
          row.city,
          row.bhk,
          row.listPrice,
          row.currency,
          row.reraId,
          row.status,
          JSON.stringify({ fromSheet: true }),
        ]
      );
      upserted += 1;
      ids.push(String(res.rows[0].id));
    }
    return {
      tool: 're',
      action,
      status: 'executed' as const,
      message: `Upserted ${upserted} listing(s) from the sheet. No extra rows invented.`,
      data: { upserted, ids, invented: false },
      timestamp,
    };
  });
}

async function createInquiry(ctx: ToolActionContext, action: ReAction): Promise<ToolExecutionResult> {
  const { payload, orgId, timestamp } = ctx;
  return withOrgScopedClient(orgId, async (client) => {
    const statusRaw = String(payload.status || 'new');
    const status = isInquiryStatus(statusRaw) ? statusRaw : 'new';
    const res = await client.query(
      `INSERT INTO re_inquiries (
         org_id, listing_id, conversation_id, contact_id, channel, status,
         bhk, locality, city, budget_max, currency, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       RETURNING id, status, created_at`,
      [
        orgId,
        payload.listingId || payload.listing_id || null,
        payload.conversationId || payload.conversation_id || null,
        payload.contactId || payload.contact_id || payload.contact || null,
        payload.channel || null,
        status,
        parseBhk(payload.bhk),
        payload.locality || payload.area || null,
        payload.city || null,
        parseBudget(payload.budget_max || payload.budgetMax || payload.maxPrice),
        payload.currency || 'INR',
        JSON.stringify({ source: payload.source || 'api' }),
      ]
    );
    const row = res.rows[0];
    const body = `Inquiry ${row.id} status=${row.status} bhk=${payload.bhk || ''} locality=${payload.locality || ''}`;
    const hash = createHash('sha256').update(body).digest('hex');
    await client.query(
      `INSERT INTO entity_memory (
         org_id, entity_type, entity_id, kind, title, body, source, source_ref, content_hash
       ) VALUES ($1, 're.inquiry', $2, 'fact', $3, $4, 'pack', $2, $5)
       ON CONFLICT (org_id, source, source_ref, content_hash) DO NOTHING`,
      [orgId, String(row.id), 're.inquiry', body, hash]
    );
    return {
      tool: 're',
      action,
      status: 'executed' as const,
      message: 'Inquiry stored.',
      data: { inquiry: { id: row.id, status: row.status, createdAt: row.created_at } },
      timestamp,
    };
  });
}

async function listInquiries(ctx: ToolActionContext, action: ReAction): Promise<ToolExecutionResult> {
  const { orgId, timestamp } = ctx;
  return withOrgScopedClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT id, listing_id, contact_id, channel, status, bhk, locality, city, budget_max, currency, updated_at
         FROM re_inquiries
        WHERE org_id = $1
        ORDER BY updated_at DESC
        LIMIT 200`,
      [orgId]
    );
    return {
      tool: 're',
      action,
      status: 'executed' as const,
      message: `${res.rows.length} inquir${res.rows.length === 1 ? 'y' : 'ies'} in this org.`,
      data: { inquiries: res.rows },
      timestamp,
    };
  });
}

async function bookShowing(ctx: ToolActionContext, action: ReAction): Promise<ToolExecutionResult> {
  const { payload, orgId, timestamp } = ctx;
  const startTime = String(payload.startTime || payload.startsAt || payload.start || '').trim();
  const listingId = payload.listingId || payload.listing_id || null;
  const inquiryId = payload.inquiryId || payload.inquiry_id || null;
  if (!startTime) {
    return apiError('re', action, timestamp, 'startTime (ISO-8601) is required to book a showing.');
  }

  const cal = await googleCalendar.execute({
    ...ctx,
    tool: 'google-calendar',
    action: 'create_event',
    actionName: 'create_event',
    payload: {
      summary: payload.summary || 'Property showing',
      startTime,
      endTime: payload.endTime || payload.endsAt,
      description: payload.description || '',
      location: payload.location || '',
    },
  });

  if (cal.status === 'error' && cal.data && (cal.data as { connected?: boolean }).connected === false) {
    await withOrgScopedClient(orgId, async (client) => {
      await client.query(
        `INSERT INTO re_showings (org_id, listing_id, inquiry_id, status, starts_at, conflict, payload)
         VALUES ($1, $2, $3, 'proposed', $4, false, $5::jsonb)`,
        [orgId, listingId, inquiryId, startTime, JSON.stringify({ calendar: 'notConnected' })]
      );
    }).catch(() => undefined);
    return {
      ...cal,
      tool: 're',
      action,
      message: 'Google Calendar is not connected. Showing was not booked. Authorize at /connectors.',
      data: {
        ...(typeof cal.data === 'object' && cal.data ? cal.data : {}),
        booked: false,
        connected: false,
        setupUrl: '/connectors',
      },
    };
  }

  if (cal.status !== 'executed') {
    return {
      tool: 're',
      action,
      status: 'error',
      message: cal.message || 'Calendar create_event failed. Showing not booked.',
      data: { booked: false, calendar: cal.data },
      timestamp,
    };
  }

  const eventId = (cal.data as { eventId?: string } | null)?.eventId || null;
  return withOrgScopedClient(orgId, async (client) => {
    const res = await client.query(
      `INSERT INTO re_showings (
         org_id, listing_id, inquiry_id, status, starts_at, ends_at, calendar_event_id, conflict, payload
       ) VALUES ($1, $2, $3, 'booked', $4, $5, $6, false, $7::jsonb)
       RETURNING id, status, starts_at`,
      [
        orgId,
        listingId,
        inquiryId,
        startTime,
        payload.endTime || payload.endsAt || null,
        eventId,
        JSON.stringify({ calendar: cal.data }),
      ]
    );
    if (inquiryId) {
      await client.query(
        `UPDATE re_inquiries SET status = 'showing' WHERE id = $1 AND org_id = $2`,
        [inquiryId, orgId]
      );
    }
    return {
      tool: 're',
      action,
      status: 'executed' as const,
      message: 'Showing booked on the org Calendar.',
      data: {
        booked: true,
        showing: res.rows[0],
        calendar: cal.data,
        connected: true,
      },
      timestamp,
    };
  });
}

async function mutateCharge(ctx: ToolActionContext, action: ReAction): Promise<ToolExecutionResult> {
  const { payload, orgId, timestamp } = ctx;
  const chargeId = String(payload.chargeId || payload.id || '').trim();
  if (!chargeId) return apiError('re', action, timestamp, 'chargeId is required');

  return withOrgScopedClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT id, org_id, status, amount, currency, psp_payment_id, closed_reason, claimed_paid_at
         FROM pm_charges WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [chargeId, orgId]
    );
    if (!res.rows[0]) {
      return apiError('re', action, timestamp, 'Charge not found in this org.');
    }
    const row = res.rows[0];
    const current: ChargeRecord = {
      id: String(row.id),
      orgId,
      status: row.status,
      amount: Number(row.amount),
      currency: String(row.currency),
      pspPaymentId: row.psp_payment_id,
      closedReason: row.closed_reason,
      claimedPaidAt: row.claimed_paid_at ? new Date(row.claimed_paid_at).toISOString() : null,
    };
    const nowIso = new Date().toISOString();
    const attempt =
      action === 'charge_claim_paid'
        ? ({ kind: 'tenant_claim' } as const)
        : payload.pspPaymentId || payload.psp_payment_id
          ? ({ kind: 'psp_webhook', pspPaymentId: String(payload.pspPaymentId || payload.psp_payment_id) } as const)
          : payload.humanConfirm === true
            ? ({ kind: 'human_confirm' } as const)
            : ({ kind: 'tenant_claim' } as const);

    const next = applyChargeEvent(current, attempt, nowIso);
    await client.query(
      `UPDATE pm_charges
          SET status = $1,
              closed_reason = $2,
              psp_payment_id = $3,
              claimed_paid_at = $4,
              closed_at = CASE WHEN $1 = 'closed' THEN NOW() ELSE closed_at END
        WHERE id = $5 AND org_id = $6`,
      [
        next.status,
        next.closedReason,
        next.pspPaymentId,
        next.claimedPaidAt,
        chargeId,
        orgId,
      ]
    );
    const closedByClaim = action === 'charge_claim_paid' && next.status === 'closed';
    return {
      tool: 're',
      action,
      status: closedByClaim ? 'error' : 'executed',
      message:
        attempt.kind === 'tenant_claim'
          ? 'Recorded tenant “I paid”. Charge stays open until a PSP webhook or human_confirm.'
          : next.status === 'closed'
            ? `Charge closed via ${next.closedReason}.`
            : 'Charge unchanged.',
      data: {
        charge: next,
        closed: next.status === 'closed',
        tenantClaimCloses: false,
      },
      timestamp,
    };
  });
}

export const realestate: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};

export const mls: ToolModule = {
  actions: ['listings_search'],
  risk: () => 'read',
  confirm: () => false,
  execute: async (ctx) =>
    notConnected('mls', ctx.actionName || 'listings_search', ctx.timestamp),
};
