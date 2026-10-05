import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { realtimeHub } from '@/lib/realtime-hub';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

const VALID_STATUSES = ['new', 'contacted', 'showing', 'closed', 'lost'] as const;
type InquiryStatus = (typeof VALID_STATUSES)[number];

function isInquiryStatus(value: unknown): value is InquiryStatus {
  return typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value);
}

function mapRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    type: 're.inquiry',
    listingRef: row.listing_id,
    contact: row.contact_id,
    contact_id: row.contact_id,
    channel: row.channel,
    status: row.status,
    bhk: row.bhk,
    locality: row.locality,
    city: row.city,
    budget_max: row.budget_max,
    sla_deadline_at: row.sla_deadline_at,
    sla_breached: row.sla_breached,
    responded_at: row.responded_at,
    assigned_agent_id: row.assigned_agent_id,
    updatedAt: row.updated_at,
    updated_at: row.updated_at,
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { client, orgId } = await getScopedClient();
    try {
      const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) {
        return NextResponse.json({ error: rejected }, { status: 400 });
      }

      if (body.status !== undefined && !isInquiryStatus(body.status)) {
        return NextResponse.json(
          { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` },
          { status: 400 }
        );
      }

      const assigned =
        typeof body.assignedAgentId === 'string'
          ? body.assignedAgentId
          : typeof body.assigned_agent_id === 'string'
            ? body.assigned_agent_id
            : body.assignedAgentId === null || body.assigned_agent_id === null
              ? null
              : undefined;

      const res = await client.query(
        `UPDATE re_inquiries
            SET status = COALESCE($1, status),
                assigned_agent_id = CASE WHEN $5::boolean THEN $2::uuid ELSE assigned_agent_id END,
                responded_at = CASE
                  WHEN status = 'new' AND $1 IS NOT NULL AND $1 <> 'new' AND responded_at IS NULL
                    THEN NOW()
                  ELSE responded_at
                END,
                sla_breached = CASE
                  WHEN status = 'new'
                       AND sla_deadline_at IS NOT NULL
                       AND sla_deadline_at < NOW()
                       AND $1 IS NOT NULL AND $1 <> 'new'
                    THEN true
                  ELSE sla_breached
                END,
                updated_at = NOW()
          WHERE id = $3 AND org_id = $4 AND deleted_at IS NULL
          RETURNING id, listing_id, contact_id, channel, status, bhk, locality, city,
                    budget_max, currency, updated_at, sla_deadline_at, sla_breached,
                    responded_at, assigned_agent_id`,
        [
          body.status ?? null,
          assigned,
          id,
          orgId,
          assigned !== undefined,
        ]
      );

      if (res.rowCount === 0) {
        return NextResponse.json({ error: 'Inquiry not found' }, { status: 404 });
      }

      const row = res.rows[0];
      realtimeHub.publish(orgId, {
        type: 'inquiry_updated',
        message: `Inquiry ${row.id} → ${row.status}`,
      });

      return NextResponse.json({ inquiry: mapRow(row) });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (/re_inquiries|does not exist|relation/i.test(message)) {
      return NextResponse.json({ error: 'Inquiries table not available' }, { status: 404 });
    }
    console.error('PATCH /api/inquiries/[id] Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `UPDATE re_inquiries
            SET deleted_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL
          RETURNING id`,
        [id, orgId]
      );
      if (res.rowCount === 0) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      realtimeHub.publish(orgId, { type: 'inquiry_deleted', message: id });
      return NextResponse.json({ success: true, id });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    console.error('DELETE /api/inquiries/[id] Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
