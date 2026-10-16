# Listings Audit

## Status: partial (CRUD + sync + pagination shipped; MLS provider pull remains Partial — no licensed API client)

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | MLS listing sync with idempotent property upserts (no invented inventory) | P0 | `api/listings/sync/route.ts` | 🟢 Done | Batch `jsonb_to_recordset` upsert on `(org_id, source, source_ref)`; `mode=pull` returns 501 + `providerPull:'partial'` (no MLS API client). Never invents rows. |
| 2 | Missing PATCH/DELETE listing routes + Add Listing UI | P0 | `api/listings/[id]`, `listings/page.tsx` | 🟢 Done | GET/PATCH/DELETE by id; Add Listing form + status select + withdraw on listings page. |
| 3 | Hardcoded LIMIT 200 / currency filter / media schema | P1–P2 | `api/listings/route.ts`, migration 098 | 🟢 Done | Keyset cursor pagination (`limit`/`cursor`/`hasMore`); optional `currency` filter; LIKE escape; amenities/media/price_history tables in 093. |

---

---

## What works (cite file:line)

1. **Multi-Tenant Filtered Inventory Queries**:
   - `apps/dashboard/app/api/listings/route.ts:11-100` — `GET /api/listings`:
     - Retrieves inventory from `re_listings` strictly scoped by tenant session via `getScopedClient()`.
     - Supports multi-field filtering: `bhk`, `locality`, `city`, and `maxPrice`.
     - Automatically restricts searching queries to active inventory (`status IN ('active', 'under_offer', 'stale')`).
     - Parses regional Indian currency shorthand (`1.2 Cr` -> `12,000,000`, `80 L` -> `8,000,000`) at `route.ts:50-63`.
     - Defends against unmigrated setups by degrading gracefully (`route.ts:95-97`) to `{ listings: [], invented: false }` on table-missing errors (`42P01`).
2. **Atomic Inventory Upserts**:
   - `apps/dashboard/app/api/listings/route.ts:102-165` — `POST /api/listings`:
     - Implements atomic upsert keyed on `(org_id, source, source_ref)` using PostgreSQL `ON CONFLICT ... DO UPDATE`.
     - Rejects client-supplied `org_id` overrides via `rejectBodyOrgId(body)`.
     - Refuses to fabricate listing IDs (`route.ts:111-117`), requiring explicit source identifiers (`source` and `source_ref`).
3. **Relational Schema Integrity**:
   - `infra/db/migrations/015_packs.sql:132-190` — `re_listings` table definition:
     - Enforces `FORCE ROW LEVEL SECURITY`.
     - Applies strict status `CHECK` constraints: `draft`, `active`, `under_offer`, `reserved`, `sold`, `rented`, `withdrawn`, `stale`.
     - Creates performance indexes on `(org_id, status)`, `(org_id, locality)`, and `(org_id, bhk, list_price)`.
4. **Live Google Sheets Inventory Synchronization**:
   - `services/workflows/src/tools/realestate/index.ts:297-377` — `re.listings_sync_sheet`:
     - Fetches live rows from Google Sheets via Nango integration, parses columns (`bhk`, `price`, `locality`, `rera_id`), and upserts into `re_listings`.
5. **Agent Long-Term Memory Linking**:
   - `services/workflows/src/tools/realestate/index.ts:238-240` — `re.listings_search`:
     - Hashes matched inventory and persists entries to `entity_memory`, allowing AI agents to reference previously presented properties across multi-turn WhatsApp and email conversations.
6. **Multi-Currency Normalization**:
   - `route.ts:50-63`:
     - Supports multiple regional currencies (INR, USD, EUR, GBP, AED) with standardized ISO 4217 code persistence.
7. **RERA ID Validation**:
   - `015_packs.sql:284-316`:
     - Integrates with `rera_cache` table to store regulatory verification states.
8. **Connection Pool Safety Across Handlers**:
   - `route.ts:98, 163`:
     - Checked-out database pool clients are guaranteed released in `finally` blocks.

---

## What's broken (code-level bugs, edge cases, failure modes)

1. **Total Absence of Mutation Endpoints (`PATCH`, `PUT`, `DELETE`) (P0)**:
   - `apps/dashboard/app/api/listings/route.ts` only implements `GET` and `POST`.
   - **There is no partial update endpoint**. To mark a property as `sold` or adjust its price, an operator must send a full `POST` upsert containing every single original field. Any omitted field is overwritten with `NULL` due to the unconditional `ON CONFLICT DO UPDATE` clause in SQL (`route.ts:138-144`).
   - There is no soft-delete or archive route; properties cannot be removed from active inventory via the REST API.
2. **Read-Only Dashboard Interface (No Creation Flow in UI) (P0)**:
   - `apps/dashboard/app/(dashboard)/listings/page.tsx` renders a read-only table and search filter.
   - There is **no "Add Property", "Edit", or "Archive" button**. Property managers who do not maintain a live Google Sheet have no way to create or modify listings inside the web app.
3. **Missing Single-Listing REST Route (`GET /api/listings/[id]`) (P1)**:
   - There is no `apps/dashboard/app/api/listings/[id]/route.ts`.
   - It is impossible to build a dedicated listing detail page (`/listings/[id]`) without executing an in-process agent tool call.
4. **Hardcoded 200-Listing Truncation (No Pagination) (`route.ts:64`) (P1)**:
   - Queries enforce `LIMIT 200` without returning total count or accepting `offset`/`cursor`.
   - For mid-sized real estate brokerages with 500+ active units, **300 listings are permanently invisible** in both the API and the UI table.
5. **Sequential N+1 Upsert Loop in Google Sheets Sync (`realestate/index.ts:340-370`) (P1)**:
   - `syncSheet` iterates over spreadsheet rows in a JavaScript `for...of` loop, executing an independent `client.query('INSERT ... ON CONFLICT')` for every row.
   - Syncing a 500-row spreadsheet runs 500 sequential SQL transactions over a single pool client, holding the connection open for 10+ seconds and risking database pool starvation (`max: 10`).
6. **Zero Asset / Multimedia Storage**:
   - `re_listings` lacks columns or relational tables for photos, floor plans, EPC certificates, or virtual tours. In modern real estate SaaS, text-only listings are unusable for customer presentation.
7. **Race Condition: Sheet Sync Overwriting Manual Dashboard Edits**:
   - If a broker manually marks a property as `under_offer` in the database, the next automated Google Sheet sync run will overwrite the status back to `active` if the spreadsheet was not updated synchronously, causing state reversion.
8. **Lack of Address Line & Geo Coordinates**:
   - Schema only stores `locality` and `city`. Exact street address, landmark, building name, and latitude/longitude coordinates are omitted, preventing map pin plotting in the UI.
9. **No Listing Expiration / Staleness Worker**:
   - `status = 'stale'` exists in the check constraint, but no cron job sweeps listings to mark properties as stale when `last_source_sync_at` exceeds 30 days.
10. **Silent Currency Mismatch on Filter Queries**:
    - `route.ts:34` filters by `list_price <= maxPrice` without checking `currency`. If an agency has listings in both USD and INR, a query for `maxPrice = 5000000` matches a $5M luxury villa and a ₹50L budget apartment equally.
11. **No RERA Registration Status in API Response**:
    - Although `rera_id` is returned, the API does not query `rera_cache` to indicate whether the registration is verified, pending, or expired.
12. **Missing Property Amenity Schema**:
    - Real estate buyers frequently search by amenities (swimming pool, gym, covered parking, power backup). Currently, there is no array or JSONB column for amenities on `re_listings`.
13. **Broken Query Parsing on Special Characters in Locality**:
    - Locality searches use plain `ILIKE '%' || $x || '%'`. If a locality name contains `%`, `_`, or single quotes, query execution can trigger SQL syntax anomalies or degrade index performance.
14. **Lack of Bulk CSV / Excel Import and Export Routes**:
    - Aside from Google Sheets via Nango, there is no direct file upload route (`POST /api/listings/import`) to import a standard CSV or Excel file, forcing non-Google users to manually type each unit.

---

## What's missing vs full product vision

1. **Property Media Management & CDN Uploads**:
   - Missing `re_listing_media` table (`listing_id`, `url`, `type`, `is_primary`, `display_order`, `caption`) and S3/R2 direct pre-signed URL upload integration.
   - AI agents currently cannot attach property photos to outgoing WhatsApp or email messages.
2. **Price History & Audit Trail**:
   - When prices change, `list_price` is overwritten in place. There is no `re_listing_price_history` table to track price drops over time or calculate days-on-market metrics.
3. **MLS & Real Estate Portal Syndication**:
   - The `mls` tool (`realestate/index.ts:624-630`) is an empty stub returning `notConnected`.
   - Missing automated feeds to syndication portals (Zillow, Realtor.com, 99acres, MagicBricks).
4. **RERA Compliance Verification UI**:
   - While `rera_cache` table exists in database migrations (`015_packs.sql:284-316`), the listings UI does not display RERA registration badges or compliance validation status.
5. **Geospatial / Proximity Search**:
   - Queries currently do simple exact text matches on `locality` and `city` (`route.ts:39-49`).
   - Real estate buyers require radius / proximity search ("within 5km of Metro station"), which requires PostGIS or lat/long bounding box queries.
6. **Property Brochure / PDF Generator**:
   - Automated generation of branded property PDFs with photos, floor plan, price, and agent WhatsApp contact link for instant sharing in customer chats.
7. **Listing Performance Analytics**:
   - Tracking views, inquiry volume, showing count, and days on market per property to provide seller reports.
8. **Automated Saved-Search Buyer Matching Engine**:
   - When a new property listing is added or price is reduced, automatically evaluate all active buyer inquiries and generate notification tasks for real estate agents.

---

## What to add for full SaaS

### 1. Implement Missing REST Routes
Create `apps/dashboard/app/api/listings/[id]/route.ts`:
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const { client, orgId } = await getScopedClient();
  try {
    const res = await client.query(`
      SELECT l.*, 
             COALESCE(json_agg(m.* ORDER BY m.display_order ASC) FILTER (WHERE m.id IS NOT NULL), '[]') as media
        FROM re_listings l
        LEFT JOIN re_listing_media m ON m.listing_id = l.id
       WHERE l.id = $1 AND l.org_id = $2
       GROUP BY l.id
    `, [params.id, orgId]);
    
    if (res.rowCount === 0) return NextResponse.json({ error: 'Listing not found' }, { status: 404 });
    return NextResponse.json({ listing: res.rows[0] });
  } finally {
    client.release();
  }
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const { client, orgId } = await getScopedClient();
  try {
    const body = await request.json();
    const rejected = rejectBodyOrgId(body);
    if (rejected) return NextResponse.json({ error: rejected }, { status: 400 });

    const { status, list_price, title, description, locality, city, amenities } = body;
    
    await client.query('BEGIN');

    // If price changed, record in history
    if (list_price !== undefined) {
      const oldPrice = await client.query(
        `SELECT list_price, currency FROM re_listings WHERE id = $1 AND org_id = $2`, 
        [params.id, orgId]
      );
      if (oldPrice.rowCount > 0 && Number(oldPrice.rows[0].list_price) !== Number(list_price)) {
        await client.query(`
          INSERT INTO re_listing_price_history (listing_id, org_id, old_price, new_price, currency)
          VALUES ($1, $2, $3, $4, $5)
        `, [params.id, orgId, oldPrice.rows[0].list_price, list_price, oldPrice.rows[0].currency]);
      }
    }

    const res = await client.query(`
      UPDATE re_listings
         SET status = COALESCE($1, status),
             list_price = COALESCE($2, list_price),
             title = COALESCE($3, title),
             locality = COALESCE($4, locality),
             city = COALESCE($5, city),
             amenities = COALESCE($6, amenities),
             updated_at = NOW()
       WHERE id = $7 AND org_id = $8
       RETURNING *
    `, [status, list_price, title, locality, city, amenities, params.id, orgId]);

    if (res.rowCount === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Listing not found' }, { status: 404 });
    }

    await client.query('COMMIT');
    return NextResponse.json({ listing: res.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const { client, orgId } = await getScopedClient();
  try {
    const res = await client.query(
      `UPDATE re_listings SET status = 'withdrawn', updated_at = NOW() WHERE id = $1 AND org_id = $2 RETURNING id`,
      [params.id, orgId]
    );
    if (res.rowCount === 0) return NextResponse.json({ error: 'Listing not found' }, { status: 404 });
    return NextResponse.json({ success: true, withdrawnId: params.id });
  } finally {
    client.release();
  }
}
```

### 2. Implement Keyset Pagination & Currency Isolation in `GET /api/listings`
In `apps/dashboard/app/api/listings/route.ts`:
```typescript
const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 100);
const cursor = searchParams.get('cursor'); // ISO timestamp
const currency = searchParams.get('currency') || 'INR';

let query = `
  SELECT id, source, source_ref, title, locality, city, bhk, list_price, currency,
         rera_id, status, amenities, last_source_sync_at, updated_at
    FROM re_listings
   WHERE org_id = $1 AND currency = $2
`;
const params: any[] = [orgId, currency];

if (cursor) {
  params.push(cursor);
  query += ` AND updated_at < $${params.length}`;
}

query += ` ORDER BY updated_at DESC LIMIT $${params.length + 1}`;
params.push(limit + 1);

const res = await client.query(query, params);
const hasMore = res.rows.length > limit;
const listings = hasMore ? res.rows.slice(0, limit) : res.rows;
const nextCursor = hasMore ? listings[listings.length - 1].updated_at : null;

return NextResponse.json({ listings, nextCursor, hasMore });
```

### 3. Optimize Google Sheets Sync to Batch Execution
Replace sequential loop in `services/workflows/src/tools/realestate/index.ts` with a single unnest query:
```typescript
export async function syncSheetBatch(client: any, orgId: string, sheetRows: any[]) {
  const rowsJson = JSON.stringify(sheetRows);
  await client.query(`
    INSERT INTO re_listings (
      org_id, source, source_ref, title, locality, city, bhk, list_price, currency, status, amenities
    )
    SELECT $1, x.source, x.source_ref, x.title, x.locality, x.city, x.bhk, x.list_price, x.currency, x.status, x.amenities
      FROM jsonb_to_recordset($2::jsonb) AS x(
        source text, source_ref text, title text, locality text, city text,
        bhk integer, list_price numeric, currency text, status text, amenities text[]
      )
    ON CONFLICT (org_id, source, source_ref) DO UPDATE SET
      title = EXCLUDED.title,
      locality = EXCLUDED.locality,
      city = EXCLUDED.city,
      bhk = EXCLUDED.bhk,
      list_price = EXCLUDED.list_price,
      currency = EXCLUDED.currency,
      status = EXCLUDED.status,
      amenities = EXCLUDED.amenities,
      last_source_sync_at = NOW(),
      updated_at = NOW();
  `, [orgId, rowsJson]);
}
```

### 4. Database Schema Migration: `024_listing_media_and_amenities.sql`
```sql
-- Migration: 024_listing_media_and_amenities.sql
-- Enables multimedia galleries, amenities catalog, price history, and geo coordinates

ALTER TABLE re_listings
  ADD COLUMN IF NOT EXISTS amenities TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS address_line TEXT,
  ADD COLUMN IF NOT EXISTS postal_code VARCHAR(16),
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS re_listing_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES re_listings(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK (media_type IN ('photo', 'floor_plan', 'video', 'document')),
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  caption TEXT,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS re_listing_price_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES re_listings(id) ON DELETE CASCADE,
  old_price NUMERIC(12, 2) NOT NULL,
  new_price NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_re_listing_media ON re_listing_media(listing_id, display_order ASC);
CREATE INDEX IF NOT EXISTS idx_re_listing_price ON re_listing_price_history(listing_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_re_listing_amenities ON re_listings USING GIN (amenities);
```

### 5. Interactive "Add Listing" Drawer in `listings/page.tsx`
```tsx
'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';

export function AddListingDrawer({ onListingAdded }: { onListingAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    bhk: 2,
    list_price: '',
    currency: 'INR',
    locality: '',
    city: 'Mumbai',
    source_ref: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/listings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...formData,
        source: 'manual_entry',
        source_ref: formData.source_ref || `prop-${Date.now()}`,
        status: 'active',
      }),
    });
    if (res.ok) {
      setOpen(false);
      onListingAdded();
    } else {
      alert('Failed to create listing');
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 shadow-sm"
      >
        <Plus className="w-4 h-4 mr-1.5" />
        Add Listing
      </button>

      {open && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/50 flex justify-end">
          <div className="w-full max-w-md bg-white dark:bg-gray-900 p-6 shadow-2xl flex flex-col h-full overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Add New Property</h3>
              <button onClick={() => setOpen(false)}><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4 flex-1">
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Property Title</label>
                <input
                  type="text" required
                  value={formData.title}
                  onChange={e => setFormData({ ...formData, title: e.target.value })}
                  placeholder="Luxury 3BHK Apartment in Bandra"
                  className="w-full border rounded-lg p-2 text-sm mt-1"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Bedrooms (BHK)</label>
                  <input
                    type="number" min="1" max="10" required
                    value={formData.bhk}
                    onChange={e => setFormData({ ...formData, bhk: parseInt(e.target.value, 10) })}
                    className="w-full border rounded-lg p-2 text-sm mt-1"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Price (e.g. 1.2 Cr)</label>
                  <input
                    type="text" required
                    value={formData.list_price}
                    onChange={e => setFormData({ ...formData, list_price: e.target.value })}
                    className="w-full border rounded-lg p-2 text-sm mt-1"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Locality</label>
                <input
                  type="text" required
                  value={formData.locality}
                  onChange={e => setFormData({ ...formData, locality: e.target.value })}
                  placeholder="Bandra West"
                  className="w-full border rounded-lg p-2 text-sm mt-1"
                />
              </div>
              <button
                type="submit"
                className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700"
              >
                Create Listing
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
```

---

## Fix priority

- **P0**: Implement `PATCH /api/listings/[id]` and `DELETE /api/listings/[id]` to allow property status updates and withdrawals.
- **P0**: Add "Add Listing" creation form and status editing controls to `listings/page.tsx`.
- **P1**: Replace sequential Google Sheets row upsert loop with a single batch transaction to prevent connection pool exhaustion.
- **P1**: Add keyset cursor pagination to `GET /api/listings` to remove the hardcoded 200-item ceiling.
- **P1**: Isolate currency filtering to prevent multi-currency comparison bugs.
- **P2**: Implement property photo upload and CDN attachment storage (`re_listing_media`).
- **P2**: Add price change history tracking and audit logging.
- **P2**: Add staleness background sweep to flag inactive listings past 30 days.
