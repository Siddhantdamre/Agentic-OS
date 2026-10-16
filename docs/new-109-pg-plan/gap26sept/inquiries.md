# Inquiries Audit

## Live Resolution Tracker
| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|---|---|---|---|---|
| 1 | Read-only Kanban — no PATCH | P0 | `api/inquiries/[id]/route.ts` | 🟢 | PATCH status/assignment; soft DELETE; session org + `rejectBodyOrgId`; realtime publish. |
| 2 | No status advance UI | P0 | `inquiries/page.tsx` | 🟢 | Advance buttons; SLA badge; load-more. |
| 3 | Phantom work-items fetch | P0 | `inquiries/page.tsx` | 🟢 | Removed; loads `/api/inquiries` only. |
| 4 | Listing CASCADE wipes inquiries | P1 | `015_packs.sql` | 🟢 | Already `ON DELETE SET NULL`. |
| 5 | Hardcoded LIMIT 200 / no pagination | P1 | `api/inquiries/route.ts` | 🟢 | Cursor pagination default 50 / max 100; status/locality filters. |
| 6 | Lead dedup + race | P1 | POST + `096_*.sql` | 🟢 | 7-day active contact refresh; partial unique index on `(org_id, contact_id)` for `status=new`. |
| 7 | Budget validation | P1 | POST | 🟢 | Rejects non-positive / NaN / overflow budgets. |
| 8 | Listing match on create | P1 | POST | 🟢 | Parameterized `re_listings` match; ids stored in `payload.matched_listing_ids` (no invented rows). |
| 9 | Realtime broadcasts | P1 | POST/PATCH/DELETE | 🟢 | `inquiry_updated` / `inquiry_deleted` via realtime hub. |
| 10 | SLA tracking | P1 | `096_*.sql` + GET/PATCH/UI | 🟢 | `sla_deadline_at` (+15m on create), breach flag, UI badge. |
| 11 | Soft delete | P2 | DELETE + GET | 🟢 | `deleted_at`; list excludes soft-deleted. |
| 12 | Workflows `re.inquiry_create` dedup | P1 | `services/workflows/src/tools/realestate/index.ts` | 🟢 | `createInquiry` refreshes active org+contact lead within 7 days (same as API); returns `deduplicated: true`. |

## Status: working (PATCH/DELETE Kanban, cursor pagination, dedup, match, SLA, workflow-tool ingest dedup)



The real estate inquiry triage system (`/inquiries`, `apps/dashboard/app/api/inquiries/route.ts`, `services/workflows/src/tools/realestate/index.ts`, and `apps/dashboard/app/(dashboard)/inquiries/page.tsx`) provides multi-tenant inquiry storage in `re_inquiries` with PostgreSQL Row-Level Security (RLS), foreign keys to `re_listings` and `conversations`, and automated status advancement to `showing` when property tours are booked. 

However, **the Kanban triage board is completely read-only** (lacks any `PATCH /api/inquiries/[id]` endpoint to advance leads between stages), duplicate lead detection is nonexistent, inquiry creation does not trigger automatic listing matching (even though the matching engine exists in `match.ts`), the frontend executes dead API fetches against non-existent `work_items?type=re.inquiry` records, and portal email ingestion lacks a dead-letter queue and SLA tracking.

---

## What works (cite file:line)

1. **Multi-Tenant Inquiry Retrieval**:
   - `apps/dashboard/app/api/inquiries/route.ts:7-49` — `GET /api/inquiries`:
     - Queries `re_inquiries` strictly filtered by session tenant `org_id = $1` and ordered by `updated_at DESC LIMIT 200`.
     - Maps rows into structured response payloads with camelCase and snake_case compatibility.
     - Employs defensive `42P01` table-missing handling (`route.ts:44-46`), returning `{ inquiries: [] }` rather than crashing during cold-start migrations.
2. **Inquiry Insertion Route with Tenant Isolation**:
   - `apps/dashboard/app/api/inquiries/route.ts:51-89` — `POST /api/inquiries`:
     - Inserts new inquiries with `rejectBodyOrgId(body)` protection against tenant spoofing.
     - Accepts parameters: `listingId`, `contact`, `channel`, `bhk`, `locality`, `budget_max`.
     - Releases the database client promptly in a `finally` block to prevent pool starvation.
3. **Agent Tool Execution & Cryptographic Memory Recall**:
   - `services/workflows/src/tools/realestate/index.ts:379-424` — `re.inquiry_create`:
     - Writes inquiry records and stores a cryptographic hash in `entity_memory` (`index.ts:406-414`), allowing subsequent AI employee turns to recall the prospect's criteria without re-querying.
     - Validates inquiry statuses against the `isInquiryStatus` enum (`new`, `contacted`, `showing`, `closed`, `lost`).
4. **Relational Schema Integrity & RLS**:
   - `infra/db/migrations/015_packs.sql:195-234` — `re_inquiries` table definition:
     - Includes status `CHECK (status IN ('new', 'contacted', 'showing', 'closed', 'lost'))` constraints and foreign keys to `re_listings`, `conversations`, and `work_items`.
     - Row Level Security is strictly enabled with `FORCE ROW LEVEL SECURITY`.
5. **Automated Lifecycle Progression via Showings**:
   - `services/workflows/src/tools/realestate/index.ts:521-526` — `bookShowing`:
     - When an agent or user schedules a showing, the system automatically executes a database update advancing the linked inquiry's status from `contacted` to `showing`.
6. **Defensive Error Handling on Missing Extensions**:
   - `apps/dashboard/app/api/inquiries/route.ts:43-48`:
     - Explicitly checks for PostgreSQL error code `42P01` (undefined table) and returns `{ inquiries: [] }` rather than an unhandled 500 error, enabling the UI to load gracefully before pack installation.
7. **Connection Pool Safety**:
   - `apps/dashboard/app/api/inquiries/route.ts:48, 86`:
     - Every database access wraps client checkout in `try ... finally { client.release() }`, preventing connection pool leakage under high concurrency.
8. **Channel Parameter Capture**:
   - `apps/dashboard/app/api/inquiries/route.ts:63-68`:
     - Ingestion captures the originating channel (`whatsapp`, `portal`, `web`, `email`, `phone`), preserving provenance for attribution analysis.

---

## What's broken (code-level bugs, edge cases, failure modes)

1. **Read-Only Kanban Board (No Status Update Endpoint) (P0)**:
   - `apps/dashboard/app/api/inquiries/route.ts` only exports `GET` and `POST`. **There is no `PATCH`, `PUT`, or `DELETE` route**.
   - `apps/dashboard/app/(dashboard)/inquiries/page.tsx:120-210` renders 4 visual Kanban columns (`New`, `Contacted`, `Showing`, `Closed/Lost`), but **has zero drag-and-drop event handlers or status dropdowns**.
   - Once an inquiry is created, an operator has **no way to advance it from New to Contacted, or mark it Closed or Lost**. The triage board is purely decorative for three of its four states.
2. **Dead Code: Phantom API Fetch on Mount (`inquiries/page.tsx:72-85`)**:
   - The Kanban board attempts to merge `/api/inquiries` with `/api/work-items?type=re.inquiry`.
   - A full codebase search confirms that `work_items` with `type = 're.inquiry'` are **never inserted anywhere in the codebase** (agent tools write directly to `re_inquiries`).
   - The second fetch is completely dead code, executing a redundant query on every page mount.
3. **Total Absence of Lead Deduplication (`realestate/index.ts:379-424`)**:
   - `createInquiry` executes an unconditional `INSERT INTO re_inquiries`.
   - If a prospect sends two WhatsApp messages asking about 2BHK apartments, or clicks "Inquire" twice on a web portal, the system creates two completely independent inquiry rows.
   - Unlike HubSpot growth contacts which have fuzzy deduplication (`checkContactDuplicateActivity`), `re_inquiries` has no phone or email de-duping.
4. **Unstructured Contact References (`015_packs.sql:201`)**:
   - `contact_id` is a bare `TEXT` column with no foreign key to `contacts` or `crm_leads`.
   - If phone numbers are formatted inconsistently (`+1 (555) 019-2834` vs `5550192834`), reverse lookups for an existing tenant fail, resulting in fragmented lead history.
5. **Disconnected Listing Matching Engine (`services/workflows/src/tools/realestate/match.ts`)**:
   - The repository contains an algorithm (`matchListings`) to match BHK, locality, and budget criteria against available inventory.
   - However, `matchListings` is **never called when an inquiry is created**. The inquiry sits in the database with zero matched listings attached, forcing human operators to manually search listings.
6. **Hardcoded 200-Row Truncation with Zero Pagination (`route.ts:16`)**:
   - `SELECT ... FROM re_inquiries ... LIMIT 200`. In a busy brokerage receiving 50 inquiries a day, older leads vanish from the Kanban board after 4 days.
   - There are no `cursor`, `page`, `status`, or `locality` query parameters supported on `GET /api/inquiries`.
7. **Race Condition: Concurrent Webhook Inquiries from Same Customer**:
   - Two rapid WhatsApp messages from the same prospective tenant spawn two parallel Temporal executions (`apps/dashboard/app/api/webhooks/whatsapp/route.ts`), each calling `re.inquiry_create` concurrently.
   - Without an advisory lock or unique constraint on `(org_id, contact_id, status) WHERE status = 'new'`, duplicate inquiries are persisted.
8. **Missing Validation on Negative or Overflow Budgets (`route.ts:65`)**:
   - `budget_max` is parsed directly as a number without checking if `budget_max > 0` or within valid numeric bounds. Submitting a negative budget or NaN is persisted into `re_inquiries.metadata`.
9. **Zero Audit Log Integration on Lifecycle Changes**:
   - When an inquiry is created or linked to a showing, no corresponding audit entry is written to `audit_logs`, preventing compliance auditing of lead handling.
10. **Missing Realtime Hub Broadcasts**:
    - Adding or updating an inquiry does not broadcast events across the WebSocket / SSE channel (`lib/realtime-hub.ts`). Multiple team members viewing the Kanban board must manually reload the page to see newly arrived leads.
11. **Loss of Inquiry When Listing is Hard-Deleted**:
    - `015_packs.sql:197`: Foreign key constraint `FOREIGN KEY (listing_id) REFERENCES re_listings(id) ON DELETE CASCADE`.
    - If a broker removes an obsolete listing, **all historical prospective tenant inquiries attached to that listing are wiped out**, losing customer contact information and pipeline history. Should be `ON DELETE SET NULL`.
12. **No Response SLA Tracking or Breach Calculation**:
    - The schema lacks fields for `sla_deadline_at`, `responded_at`, or `sla_breached`. Brokerages cannot track whether the 15-minute response SLA was met.

---

## What's missing vs full product vision

1. **Lead Assignment & Round-Robin Routing**:
   - Missing the ability to assign an inquiry to a specific human leasing agent or AI employee (`assigned_agent_id`).
   - Lack of round-robin distribution among broker team members based on geographic locality or availability.
2. **Response SLA Tracking & Real-Time Breach Alerts**:
   - Property management companies enforce strict 15-minute lead response SLAs.
   - The system lacks SLA timers, visual warnings (amber/red tags), and notification alerts when inquiries linger in `new` status past threshold.
3. **Automated Outbound Auto-Responder**:
   - When an inquiry arrives via email or web widget, the system does not automatically dispatch an introductory WhatsApp or Email message containing matched property links.
4. **Activity & Communication Timeline Drawer**:
   - Operators cannot view the thread of conversations, phone calls, or scheduled tours directly inside the inquiry card.
5. **Channel Attribution & Source Tracking**:
   - Lacks UTM parameter capture (e.g. `utm_source=facebook_ad`, `campaign=q3_penthouses`) to measure which marketing channels generate qualified inquiries.
6. **Multi-Touch Lead Scoring Engine**:
   - Lack of dynamic score calculation (e.g., immediate move-in + pre-approved budget = High Priority 95/100).
7. **Direct Tour Scheduling Link in Inquiries**:
   - Prospective tenants cannot be sent a self-serve scheduling link linked directly to their inquiry ID.
8. **Export and CRM Sync**:
   - Missing CSV export and two-way synchronization with external CRMs (Salesforce, HubSpot, FollowUpBoss).

---

## What to add for full SaaS

### 1. Database Schema Enhancement Migration
Create `infra/db/migrations/024_inquiries_pipeline_and_sla.sql`:
```sql
-- Fix destructive cascading delete: preserve inquiries when listing is deleted
ALTER TABLE re_inquiries DROP CONSTRAINT IF EXISTS re_inquiries_listing_id_fkey;
ALTER TABLE re_inquiries ADD CONSTRAINT re_inquiries_listing_id_fkey 
  FOREIGN KEY (listing_id) REFERENCES re_listings(id) ON DELETE SET NULL;

-- Pipeline enhancements and SLA fields
ALTER TABLE re_inquiries
  ADD COLUMN IF NOT EXISTS assigned_agent_id TEXT,
  ADD COLUMN IF NOT EXISTS lead_score INTEGER DEFAULT 50 CHECK (lead_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS sla_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_contacted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_utm JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Indices for rapid Kanban rendering and SLA monitoring
CREATE INDEX IF NOT EXISTS idx_re_inquiries_org_status_updated 
  ON re_inquiries (org_id, status, updated_at DESC) 
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_re_inquiries_sla_monitoring 
  ON re_inquiries (org_id, sla_deadline_at) 
  WHERE status = 'new' AND sla_breached = false;

CREATE INDEX IF NOT EXISTS idx_re_inquiries_contact_dedup 
  ON re_inquiries (org_id, contact_id, status) 
  WHERE status IN ('new', 'contacted');
```

### 2. Implement `apps/dashboard/app/api/inquiries/[id]/route.ts`
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { broadcastToOrg } from '@/lib/realtime-hub';

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const body = await request.json();
    const rejected = rejectBodyOrgId(body);
    if (rejected) return NextResponse.json({ error: rejected }, { status: 400 });

    const { status, notes, assignedAgentId, leadScore } = body;
    const validStatuses = ['new', 'contacted', 'showing', 'closed', 'lost'];
    if (status && !validStatuses.includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }

    const res = await client.query(
      `UPDATE re_inquiries
          SET status = COALESCE($1, status),
              notes = COALESCE($2, notes),
              assigned_agent_id = COALESCE($3, assigned_agent_id),
              lead_score = COALESCE($4, lead_score),
              first_contacted_at = CASE 
                WHEN status = 'new' AND $1 = 'contacted' THEN NOW() 
                ELSE first_contacted_at 
              END,
              sla_breached = CASE 
                WHEN status = 'new' AND sla_deadline_at < NOW() AND $1 <> 'new' THEN true 
                ELSE sla_breached 
              END,
              updated_at = NOW()
        WHERE id = $5 AND org_id = $6 AND deleted_at IS NULL
        RETURNING *`,
      [status, notes, assignedAgentId, leadScore, params.id, orgId]
    );

    if (res.rowCount === 0) {
      return NextResponse.json({ error: 'Inquiry not found' }, { status: 404 });
    }

    const updated = res.rows[0];

    // Audit log entry
    await client.query(
      `INSERT INTO audit_logs (org_id, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'inquiry.updated', 're_inquiry', $3, $4::jsonb)`,
      [orgId, userId || 'system', params.id, JSON.stringify({ oldStatus: body.oldStatus, newStatus: status })]
    );

    // Broadcast update via WebSocket/SSE
    broadcastToOrg(orgId, {
      type: 'inquiry_updated',
      inquiry: updated,
    });

    return NextResponse.json({ inquiry: updated });
  } finally {
    client.release();
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const res = await client.query(
      `UPDATE re_inquiries 
          SET deleted_at = NOW(), updated_at = NOW() 
        WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
        RETURNING id`,
      [params.id, orgId]
    );
    if (res.rowCount === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    broadcastToOrg(orgId, { type: 'inquiry_deleted', id: params.id });
    return NextResponse.json({ success: true });
  } finally {
    client.release();
  }
}
```

### 3. Automatic Deduplication and Listing Matching on Ingestion
In `services/workflows/src/tools/realestate/index.ts:395`:
```typescript
// 1. Check for active duplicate inquiry within last 7 days
const existing = await client.query(
  `SELECT id, notes FROM re_inquiries 
    WHERE org_id = $1 AND contact_id = $2 AND status IN ('new', 'contacted')
      AND created_at > NOW() - INTERVAL '7 days'
    ORDER BY updated_at DESC LIMIT 1`,
  [orgId, params.contact]
);

if (existing.rowCount > 0) {
  const existingId = existing.rows[0].id;
  await client.query(
    `UPDATE re_inquiries 
        SET updated_at = NOW(), 
            notes = CONCAT(COALESCE(notes, ''), E'\n[Additional Inquiry] ', $1) 
      WHERE id = $2`,
    [params.notes || 'Inquired again on property', existingId]
  );
  return { inquiryId: existingId, deduplicated: true, status: 'updated' };
}

// 2. Perform automated inventory match
const matches = await matchListings(client, orgId, {
  bhk: params.bhk,
  locality: params.locality,
  city: params.city,
  maxPrice: params.budgetMax,
});

// 3. Insert with 15-minute response SLA deadline
const insertRes = await client.query(
  `INSERT INTO re_inquiries (
     org_id, listing_id, contact_id, channel, bhk, locality, budget_max, 
     status, sla_deadline_at, metadata
   ) VALUES (
     $1, $2, $3, $4, $5, $6, $7, 
     'new', NOW() + INTERVAL '15 minutes', $8::jsonb
   ) RETURNING id`,
  [
    orgId, params.listingId || null, params.contact, params.channel || 'web',
    params.bhk || null, params.locality || null, params.budgetMax || null,
    JSON.stringify({ matched_listing_ids: matches.map(m => m.id) })
  ]
);
```

### 4. Interactive Kanban Board React Component (`inquiries/KanbanBoard.tsx`)
```tsx
'use client';

import { useState } from 'react';
import { Clock, AlertTriangle, ArrowRight, UserCheck, MessageSquare } from 'lucide-react';

interface Inquiry {
  id: string;
  contact: string;
  status: 'new' | 'contacted' | 'showing' | 'closed' | 'lost';
  bhk?: number;
  locality?: string;
  budget_max?: number;
  sla_deadline_at?: string;
  created_at: string;
}

const COLUMNS: Array<{ id: Inquiry['status']; label: string; bg: string }> = [
  { id: 'new', label: 'New Leads', bg: 'bg-blue-50 dark:bg-blue-950/20' },
  { id: 'contacted', label: 'Contacted', bg: 'bg-amber-50 dark:bg-amber-950/20' },
  { id: 'showing', label: 'Tour Booked', bg: 'bg-purple-50 dark:bg-purple-950/20' },
  { id: 'closed', label: 'Closed / Signed', bg: 'bg-emerald-50 dark:bg-emerald-950/20' },
];

export function InquiryKanbanBoard({ initialInquiries }: { initialInquiries: Inquiry[] }) {
  const [inquiries, setInquiries] = useState<Inquiry[]>(initialInquiries);
  const [movingId, setMovingId] = useState<string | null>(null);

  const moveStatus = async (id: string, newStatus: Inquiry['status']) => {
    setMovingId(id);
    try {
      const res = await fetch(`/api/inquiries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error('Failed to advance inquiry status');
      setInquiries(inquiries.map(inq => inq.id === id ? { ...inq, status: newStatus } : inq));
    } catch (err: any) {
      alert(err.message);
    } finally {
      setMovingId(null);
    }
  };

  const isSlaBreached = (deadline?: string) => {
    if (!deadline) return false;
    return new Date(deadline).getTime() < Date.now();
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 p-4">
      {COLUMNS.map(col => (
        <div key={col.id} className={`rounded-xl p-3 border border-gray-200 dark:border-gray-800 ${col.bg}`}>
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-semibold text-sm text-gray-900 dark:text-gray-100">{col.label}</h3>
            <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-white dark:bg-gray-800 border">
              {inquiries.filter(i => i.status === col.id).length}
            </span>
          </div>

          <div className="space-y-2.5">
            {inquiries
              .filter(inq => inq.status === col.id)
              .map(inq => (
                <div key={inq.id} className="bg-white dark:bg-gray-900 rounded-lg p-3 border shadow-sm">
                  <div className="flex justify-between items-start mb-2">
                    <span className="font-medium text-xs text-gray-900 dark:text-gray-100">{inq.contact}</span>
                    {col.id === 'new' && isSlaBreached(inq.sla_deadline_at) && (
                      <span className="inline-flex items-center text-[10px] text-red-600 bg-red-50 dark:bg-red-950/40 px-1.5 py-0.5 rounded font-medium">
                        <AlertTriangle className="w-3 h-3 mr-0.5" /> SLA Breached
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mb-2">
                    {inq.bhk ? `${inq.bhk} BHK` : 'Property'}{inq.locality ? ` · ${inq.locality}` : ''}
                    {inq.budget_max ? ` · Max: ₹${inq.budget_max.toLocaleString()}` : ''}
                  </p>
                  
                  <div className="flex justify-between items-center pt-2 border-t text-[11px]">
                    <span className="text-gray-400">
                      {new Date(inq.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {col.id !== 'closed' && (
                      <button
                        disabled={movingId === inq.id}
                        onClick={() => {
                          const nextIdx = COLUMNS.findIndex(c => c.id === col.id) + 1;
                          if (nextIdx < COLUMNS.length) moveStatus(inq.id, COLUMNS[nextIdx].id);
                        }}
                        className="text-blue-600 dark:text-blue-400 font-medium inline-flex items-center hover:underline"
                      >
                        Advance <ArrowRight className="w-3 h-3 ml-0.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

### 5. Round-Robin Lead Assignment Algorithm (`services/workflows/src/tools/realestate/lead-routing.ts`)
```typescript
export async function assignInquiryRoundRobin(client: any, orgId: string, inquiryId: string): Promise<string | null> {
  // Fetch active human agents and AI employees in this org
  const availableAgents = await client.query(
    `SELECT u.id, u.email, 
            COUNT(i.id) FILTER (WHERE i.status IN ('new', 'contacted')) AS active_inquiries
       FROM users u
       LEFT JOIN re_inquiries i ON i.assigned_agent_id = u.id AND i.org_id = $1
      WHERE u.org_id = $1 AND u.role IN ('admin', 'member')
      GROUP BY u.id
      ORDER BY active_inquiries ASC, u.created_at ASC
      LIMIT 1`,
    [orgId]
  );

  if (availableAgents.rowCount === 0) return null;
  const chosenAgentId = availableAgents.rows[0].id;

  await client.query(
    `UPDATE re_inquiries SET assigned_agent_id = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3`,
    [chosenAgentId, inquiryId, orgId]
  );

  return chosenAgentId;
}
```

### 6. Database Migration: `022_inquiries_sla_and_lifecycle.sql`
```sql
-- Migration: 022_inquiries_sla_and_lifecycle.sql
-- Enables SLA tracking, round-robin assignments, and non-destructive listing deletions

ALTER TABLE re_inquiries
  DROP CONSTRAINT IF EXISTS re_inquiries_listing_id_fkey,
  ADD CONSTRAINT re_inquiries_listing_id_fkey 
    FOREIGN KEY (listing_id) REFERENCES re_listings(id) ON DELETE SET NULL;

ALTER TABLE re_inquiries
  ADD COLUMN IF NOT EXISTS assigned_agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sla_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_inquiries_sla_tracker 
  ON re_inquiries (org_id, sla_deadline_at) 
  WHERE status = 'new' AND responded_at IS NULL;
```

---

## Fix priority

- **P0**: Implement `apps/dashboard/app/api/inquiries/[id]/route.ts` (`PATCH` and `DELETE`) so inquiries can progress through pipeline stages.
- **P0**: Update `inquiries/page.tsx` with interactive status selection and eliminate phantom `work-items` fetch.
- **P1**: Prevent cascade deletion of inquiries when listings are deleted (`ALTER TABLE re_inquiries DROP CONSTRAINT ... ON DELETE SET NULL`).
- **P1**: Run automated `matchListings` upon inquiry creation and store matched listing IDs in metadata.
- **P1**: Implement inbound lead deduplication by contact phone/email.
- **P2**: Add SLA deadline tracking and real-time visual breach indicators.
- **P2**: Emit real-time WebSocket events (`inquiry_updated`, `inquiry_deleted`) through `realtime-hub.ts`.
