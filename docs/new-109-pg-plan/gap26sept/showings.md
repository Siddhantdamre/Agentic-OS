# Showings Audit

## Status: working (conflict checks, cancel/PATCH, agenda, Temporal reminders, GCal push webhook)

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Showing booking must check calendar conflicts; fail closed if calendar disconnected | P0 | `api/showings/route.ts`, `connectors/src/calendar.ts` | 🟢 Done | DB overlap + live Google freeBusy before book; disconnected/expired → `connected:false` + `reconnectUrl`, no book. |
| 2 | Cosmetic Cancel / missing PATCH+DELETE showing routes | P0 | `api/showings/[id]`, `SchedulePanel.tsx`, `/showings` page | 🟢 Done | PATCH/DELETE with conflict re-check; DELETE removes calendar event best-effort; Cancel showing calls API; agenda page with cancel. |
| 3 | Ambiguous timezone / duration / reminders / two-way sync | P1–P2 | SchedulePanel + POST showings + migration 102 + ShowingReminderWorkflow + GCal webhook | 🟢 Done | IANA timezone + durationMinutes on book. `ShowingReminderWorkflow` sleeps to 24h/2h, activity skips when status=cancelled. `POST /api/webhooks/google-calendar` verifies `X-Goog-Channel-Token` (fail closed); missing webhook URL → persist `not_configured` (no fake sync). Only updates showings that already have `calendar_event_id`. |

---

---

## What works (cite file:line)

1. **Multi-Tenant Scoped Showing Retrieval**:
   - `apps/dashboard/app/api/showings/route.ts:21-74` — `GET /api/showings`:
     - Retrieves showings from `re_showings` strictly scoped to session tenant `org_id` via `getScopedClient()`.
     - Supports UUID filtering for `listingId` and `inquiryId` with strict `UUID_RE` regex validation (`route.ts:9-15`).
     - Safely returns `{ showings: [] }` if database migration tables are missing (`missingTables` check, `route.ts:67-72`).
2. **Robust Multi-Tenant Booking Validation**:
   - `apps/dashboard/app/api/showings/route.ts:76-200` — `POST /api/showings`:
     - Rejects spoofed client `org_id` via `rejectBodyOrgId`.
     - Validates ISO-8601 start and end timestamps, defaulting `endTime` to `startTime + 1 hour` if omitted.
     - Verifies that both `listingId` and `inquiryId` genuinely belong to the authenticated organization before scheduling, preventing cross-tenant appointment hijacking (`route.ts:130-149`).
     - Generates deterministic idempotency keys (`showing:${orgId}:${listingId||inquiryId}:${startTime}`).
     - Implements dual-path execution: triggers `ShowingScheduleWorkflow` in Temporal, falling back gracefully to in-process `bookShowingActivity` if the Temporal worker is offline.
3. **Live Google Calendar Event Creation**:
   - `services/workflows/src/tools/realestate/index.ts:448-541` — `bookShowing`:
     - Calls `googleCalendar.execute('create_event')` with real event title, description, and attendee details.
     - If Google Calendar is not connected, it honestly records a `re_showings` row with `status: 'proposed'` and returns `connected: false` with setup URL `/connectors`, refusing to fabricate a confirmed booking.
     - When connected, it stores the real `calendar_event_id` and advances `re_inquiries.status = 'showing'` (`lines 521-526`).
4. **Interactive UI Booking Control**:
   - `apps/dashboard/components/re/SchedulePanel.tsx:45-138` — `BookShowingControl`:
     - Provides an inline `datetime-local` picker on both the Listings table and Inquiries Kanban board with loading spinner states.
5. **Idempotent Workflow Execution**:
   - `services/workflows/src/workflows/ShowingScheduleWorkflow.ts:14-45`:
     - Uses deterministic workflow ID generation based on tenant ID, property ID, and slot time, preventing duplicate background job execution when network requests retry.
6. **Graceful Degradation When Google Calendar Is Disconnected**:
   - `services/workflows/src/tools/realestate/index.ts:468-479`:
     - Rather than throwing an unhandled exception when OAuth is not configured, the system logs a `proposed` showing in `re_showings` and returns actionable instructions pointing the broker to the OAuth configuration panel.
7. **Automated Inquiry Status Advancement**:
   - `services/workflows/src/tools/realestate/index.ts:522`:
     - Seamlessly transitions associated `re_inquiries` rows from `contacted` to `showing`, ensuring pipeline consistency across tables.

---

## What's broken (code-level bugs, edge cases, failure modes)

1. **Unfulfilled Schema Promise: `conflict` Is Always Hardcoded `false` (P0) (`realestate/index.ts:474, 509`)**:
   - The `re_showings` table schema defines a boolean column `conflict` to flag double-bookings.
   - However, `bookShowing` unconditionally inserts `conflict: false` across all paths.
   - The system **never checks Google Calendar free/busy availability or overlapping `re_showings` rows** before booking. Two agents can book the exact same apartment at 2:00 PM on Tuesday; both succeed, and neither flags a conflict.
2. **Cosmetic "Cancel" Button in UI Performs Zero Server Action (P0) (`SchedulePanel.tsx:114-119`)**:
   - In `SchedulePanel.tsx`, the card displays a prominent "Cancel" button.
   - Clicking this button merely executes `setOpen(false)`, closing the local React form modal.
   - It does **not call any API, does not cancel the showing in the database, and does not delete the Google Calendar event**. Users believe they cancelled a showing, but the appointment remains live on the agent's calendar.
3. **Total Absence of Cancellation and Rescheduling Endpoints (`route.ts`)**:
   - `apps/dashboard/app/api/showings/route.ts` only exports `GET` and `POST`.
   - There is **no `PATCH /api/showings/[id]` or `DELETE /api/showings/[id]`**.
   - A booked tour cannot be marked `completed`, `cancelled`, or `no_show`, leaving appointments permanently stranded in the `booked` state.
4. **Request Loss on Google Calendar API Failure (`realestate/index.ts:493-502`)**:
   - If Google Calendar returns a transient 5xx error or rate limit, `bookShowing` throws an error and **does not insert any database record**.
   - The prospect's requested tour slot is completely dropped from memory and database, with no fallback record created for human follow-up.
5. **Ambiguous Timezone Handling in Date Inputs (`SchedulePanel.tsx:92`)**:
   - The browser `input type="datetime-local"` produces a naked string without timezone offset (e.g. `2026-10-04T15:00`).
   - When parsed on a server running in UTC, a client in Los Angeles (UTC-7) scheduling for 3:00 PM local time will have their calendar event booked at 3:00 PM UTC (8:00 AM local time), causing missed appointments.
6. **No Showing Duration Configuration**:
   - Every showing is hardcoded to 60 minutes (`route.ts:109`). Fast apartment walkthroughs (30m) or commercial property tours (90m) cannot adjust duration.
7. **Race Condition: Concurrent Booking Invocations for the Same Slot**:
   - If two prospects submit booking requests for the same listing at the exact same start time simultaneously, both pass the route checks before either record commits, inserting two conflicting bookings.
8. **Lack of Operating Hours Validation**:
   - The system allows bookings at 3:30 AM on Sunday morning. There is no organization-level or agent-level availability schedule enforced.
9. **Missing Transit Buffer Times**:
   - Back-to-back showings can be scheduled across properties in different cities with 0 minutes buffer time, guaranteeing broker tardiness.
10. **Dead Appointment Status Lifecycle**:
    - Showings remain in status `booked` indefinitely after their `ends_at` time passes. There is no automated cron or worker that marks past showings as `completed` or prompts the broker for tour outcome.
11. **External Google Calendar Event Drift**:
    - If a client or agent deletes or moves an appointment directly inside Google Calendar, Darex is never notified (no Google Calendar push webhook receiver), leading to ghost appointments.
12. **No Audit Logging on Tour Events**:
    - Scheduling, moving, or cancelling appointments fails to write to `audit_logs`.

---

## What's missing vs full product vision

1. **Two-Way Google & Outlook Calendar Synchronization**:
   - Webhook listener to sync cancellations, reschedules, and external edits directly back to Darex.
2. **Dedicated `/showings` Calendar / Agenda View**:
   - A full dashboard page with Month, Week, Day, and Agenda views displaying all showings, assigned agents, and property locations on a map.
3. **Automated WhatsApp / SMS Reminders via Temporal**:
   - Workflow scheduled to trigger:
     - 24 hours prior: Confirmation request ("Reply 1 to Confirm or 2 to Reschedule").
     - 2 hours prior: Location map link, entry gate code, and agent contact details.
4. **Post-Showing Feedback Collection Workflow**:
   - Automatic WhatsApp message 1 hour post-tour asking:
     - Rating (1-5 stars)
     - Interest level (Apply Now / Interested / Price Too High / Not Interested)
     - Automated handoff to contract generation if "Apply Now" is selected.
5. **Agent Route Optimization & Geographic Clustering**:
   - Grouping showings by locality to minimize broker transit time.
6. **Self-Serve Prospect Rescheduling Portal**:
   - Secure tokenized URL sent to prospects allowing them to pick a new available slot without broker intervention.
7. **No-Show Rate Analytics**:
   - Reporting on prospect cancellation rates by lead source, locality, and agent.

---

## What to add for full SaaS

### 1. Database Schema Enhancements Migration
Create `infra/db/migrations/025_showings_conflicts_and_lifecycle.sql`:
```sql
ALTER TABLE re_showings
  ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS duration_minutes INTEGER DEFAULT 60 CHECK (duration_minutes > 0),
  ADD COLUMN IF NOT EXISTS conflict_details JSONB,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS feedback_rating INTEGER CHECK (feedback_rating BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS feedback_notes TEXT,
  ADD COLUMN IF NOT EXISTS reminder_24h_sent BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_2h_sent BOOLEAN DEFAULT false;

-- Add partial index for conflict detection
CREATE INDEX IF NOT EXISTS idx_re_showings_conflict_check 
  ON re_showings (org_id, listing_id, starts_at, ends_at) 
  WHERE status IN ('booked', 'proposed');

-- Index for upcoming showing cron sweeps
CREATE INDEX IF NOT EXISTS idx_re_showings_reminders 
  ON re_showings (org_id, starts_at) 
  WHERE status = 'booked';
```

### 2. Implement `apps/dashboard/app/api/showings/[id]/route.ts`
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { broadcastToOrg } from '@/lib/realtime-hub';
import { googleCalendar } from '@/services/connectors';

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const body = await request.json();
    const rejected = rejectBodyOrgId(body);
    if (rejected) return NextResponse.json({ error: rejected }, { status: 400 });

    const { status, startsAt, endsAt, feedbackRating, feedbackNotes, cancellationReason } = body;

    // Check existing showing
    const existing = await client.query(
      `SELECT * FROM re_showings WHERE id = $1 AND org_id = $2`,
      [params.id, orgId]
    );
    if (existing.rowCount === 0) {
      return NextResponse.json({ error: 'Showing not found' }, { status: 404 });
    }
    const current = existing.rows[0];

    // If rescheduling, check conflicts
    if (startsAt && endsAt) {
      const conflictCheck = await client.query(
        `SELECT id FROM re_showings
          WHERE org_id = $1 AND listing_id = $2 AND id <> $3
            AND status = 'booked'
            AND starts_at < $5 AND ends_at > $4`,
        [orgId, current.listing_id, params.id, startsAt, endsAt]
      );
      if (conflictCheck.rowCount > 0) {
        return NextResponse.json({ error: 'Time slot conflicts with another showing' }, { status: 409 });
      }
    }

    const res = await client.query(
      `UPDATE re_showings
          SET status = COALESCE($1, status),
              starts_at = COALESCE($2, starts_at),
              ends_at = COALESCE($3, ends_at),
              feedback_rating = COALESCE($4, feedback_rating),
              feedback_notes = COALESCE($5, feedback_notes),
              cancellation_reason = COALESCE($6, cancellation_reason),
              updated_at = NOW()
        WHERE id = $7 AND org_id = $8
        RETURNING *`,
      [status, startsAt, endsAt, feedbackRating, feedbackNotes, cancellationReason, params.id, orgId]
    );

    const updated = res.rows[0];

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (org_id, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'showing.updated', 're_showing', $3, $4::jsonb)`,
      [orgId, userId || 'system', params.id, JSON.stringify({ oldStatus: current.status, newStatus: updated.status })]
    );

    broadcastToOrg(orgId, { type: 'showing_updated', showing: updated });
    return NextResponse.json({ showing: updated });
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
    const existing = await client.query(
      `SELECT calendar_event_id FROM re_showings WHERE id = $1 AND org_id = $2`,
      [params.id, orgId]
    );
    if (existing.rowCount === 0) return NextResponse.json({ error: 'Showing not found' }, { status: 404 });

    const calendarEventId = existing.rows[0].calendar_event_id;

    // Delete Google Calendar Event if it exists
    if (calendarEventId) {
      try {
        await googleCalendar.execute('delete_event', { eventId: calendarEventId, orgId });
      } catch (calErr) {
        console.error('Failed to delete Google Calendar event:', calErr);
      }
    }

    // Mark as cancelled in database
    await client.query(
      `UPDATE re_showings 
          SET status = 'cancelled', updated_at = NOW() 
        WHERE id = $1 AND org_id = $2`,
      [params.id, orgId]
    );

    await client.query(
      `INSERT INTO audit_logs (org_id, actor_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'showing.cancelled', 're_showing', $3)`,
      [orgId, userId || 'system', params.id]
    );

    broadcastToOrg(orgId, { type: 'showing_cancelled', id: params.id });
    return NextResponse.json({ success: true, message: 'Showing cancelled' });
  } finally {
    client.release();
  }
}
```

### 3. Pre-Booking Overlap & Free/Busy Conflict Checker
In `services/workflows/src/tools/realestate/index.ts:465`:
```typescript
// 1. Transactional DB Overlap Check with row lock
const conflictRes = await client.query(
  `SELECT id, starts_at, ends_at FROM re_showings
    WHERE org_id = $1 AND listing_id = $2 AND status = 'booked'
      AND starts_at < $4 AND ends_at > $3
    LIMIT 1`,
  [orgId, params.listingId, startTime, endTime]
);

if (conflictRes.rowCount > 0) {
  const conflict = conflictRes.rows[0];
  return {
    status: 'conflict',
    conflict: true,
    message: `Conflict detected: Property is already booked from ${conflict.starts_at} to ${conflict.ends_at}.`,
  };
}

// 2. Query Google Calendar Free/Busy if connected
let gcalBusy = false;
try {
  const busySlots = await googleCalendar.queryFreeBusy({
    orgId,
    timeMin: startTime,
    timeMax: endTime,
  });
  if (busySlots.length > 0) gcalBusy = true;
} catch (e) {
  // Graceful degradation if calendar query fails
}
```

### 4. Interactive Cancellation in `SchedulePanel.tsx`
Replace inert `setOpen(false)` with server-backed cancellation:
```typescript
async function cancelShowing(showingId: string) {
  const confirmed = confirm('Are you sure you want to cancel this showing? It will be removed from Google Calendar.');
  if (!confirmed) return;

  const res = await fetch(`/api/showings/${showingId}`, { method: 'DELETE' });
  if (res.ok) {
    toast.success('Showing successfully cancelled.');
    onShowingUpdated?.();
  } else {
    toast.error('Failed to cancel showing.');
  }
}
```

### 5. Automated Showing Reminders Temporal Workflow (`services/workflows/src/workflows/ShowingReminderWorkflow.ts`)
```typescript
import { sleep, proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/showing-activities';

const { sendShowingReminderWhatsAppActivity, updateShowingStatusActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

export async function ShowingReminderWorkflow(input: {
  showingId: string;
  orgId: string;
  startsAt: string; // ISO string
  prospectPhone: string;
  propertyTitle: string;
  propertyAddress: string;
}): Promise<void> {
  const startTimeMs = new Date(input.startsAt).getTime();
  const nowMs = Date.now();

  // 1. Calculate delay until 24 hours prior to showing
  const remind24hMs = startTimeMs - 24 * 3600 * 1000 - nowMs;
  if (remind24hMs > 0) {
    await sleep(remind24hMs);
    await sendShowingReminderWhatsAppActivity({
      phone: input.prospectPhone,
      message: `Hi! Quick reminder about your tour tomorrow for ${input.propertyTitle} at ${new Date(input.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Reply '1' to Confirm or '2' to Reschedule.`,
      orgId: input.orgId,
    });
  }

  // 2. Calculate delay until 2 hours prior to showing
  const remind2hMs = startTimeMs - 2 * 3600 * 1000 - Date.now();
  if (remind2hMs > 0) {
    await sleep(remind2hMs);
    await sendShowingReminderWhatsAppActivity({
      phone: input.prospectPhone,
      message: `Your property tour is in 2 hours! Address: ${input.propertyAddress}. Our agent is ready to meet you.`,
      orgId: input.orgId,
    });
  }

  // 3. Mark completed 1 hour post-showing
  const postTourMs = startTimeMs + 1 * 3600 * 1000 - Date.now();
  if (postTourMs > 0) {
    await sleep(postTourMs);
    await updateShowingStatusActivity({ showingId: input.showingId, status: 'completed', orgId: input.orgId });
  }
}
```

### 6. Dedicated Showings Agenda Dashboard View (`apps/dashboard/app/(dashboard)/showings/page.tsx`)
```tsx
'use client';

import { useEffect, useState } from 'react';
import { Calendar, Clock, MapPin, CheckCircle, XCircle } from 'lucide-react';

export function ShowingsDashboardPage() {
  const [showings, setShowings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/showings')
      .then(res => res.json())
      .then(data => {
        setShowings(data.showings || []);
        setLoading(false);
      });
  }, []);

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Property Showings</h1>
          <p className="text-sm text-gray-500">Manage upcoming buyer and tenant property walkthroughs.</p>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-xl border divide-y">
        {showings.map(s => (
          <div key={s.id} className="p-4 flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="p-3 bg-blue-50 dark:bg-blue-950/40 rounded-lg text-blue-600">
                <Calendar className="w-5 h-5" />
              </div>
              <div>
                <h4 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
                  {s.listing_title || 'Property Walkthrough'}
                </h4>
                <div className="flex items-center space-x-3 text-xs text-gray-500 mt-1">
                  <span className="flex items-center">
                    <Clock className="w-3.5 h-3.5 mr-1" />
                    {new Date(s.starts_at).toLocaleString()}
                  </span>
                  <span className="flex items-center">
                    <MapPin className="w-3.5 h-3.5 mr-1" />
                    {s.locality || 'On-site'}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-3">
              <span className={`px-2.5 py-1 text-xs rounded-full font-medium ${
                s.status === 'booked' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600'
              }`}>
                {s.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 7. Database Migration: `021_showings_conflicts_and_timezones.sql`
```sql
-- Migration: 021_showings_conflicts_and_timezones.sql
-- Enables timezone handling, calendar conflict detection, and tour feedback

ALTER TABLE re_showings
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS duration_minutes INT DEFAULT 60,
  ADD COLUMN IF NOT EXISTS feedback_rating SMALLINT CHECK (feedback_rating BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS feedback_notes TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_re_showings_conflict_check 
  ON re_showings (org_id, listing_id, starts_at, ends_at) 
  WHERE status = 'booked';
```

---

## Fix priority

- **P0**: Implement real conflict checking in `bookShowing` and reject or flag overlapping property tours.
- **P0**: Build `apps/dashboard/app/api/showings/[id]/route.ts` (`PATCH` and `DELETE`) to support rescheduling and real cancellations.
- **P0**: Wire real `DELETE /api/showings/[id]` into `SchedulePanel.tsx` to eliminate the cosmetic cancel button bug.
- **P1**: Transmit client IANA timezone string in `BookShowingControl` to eliminate UTC shift discrepancies.
- **P1**: Create dedicated `/showings` calendar/agenda dashboard view.
- **P2**: Implement two-way Google Calendar webhook listener for out-of-band sync.
- **P2**: Launch Temporal `ShowingReminderWorkflow` for automated WhatsApp/SMS reminders 24 hours and 2 hours prior to tour.
