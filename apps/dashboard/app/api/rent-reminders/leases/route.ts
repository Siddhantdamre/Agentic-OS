import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { rejectBodyOrgId } from '@/app/api/packs/_lib';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

function missingTables(message: string): boolean {
  return /pm_leases|does not exist|relation/i.test(message);
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT id, source, source_ref, unit_ref, tenant_ref, status, payload, created_at, updated_at
           FROM pm_leases
          WHERE org_id = $1
          ORDER BY created_at DESC
          LIMIT 200`,
        [orgId]
      );
      return NextResponse.json({
        leases: res.rows.map((row) => ({
          id: row.id,
          source: row.source,
          sourceRef: row.source_ref,
          unitRef: row.unit_ref,
          tenantRef: row.tenant_ref,
          status: row.status,
          payload: row.payload,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })),
        invented: false,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    const message = err instanceof Error ? err.message : String(err);
    if (missingTables(message)) {
      return NextResponse.json({ leases: [], invented: false });
    }
    console.error('GET /api/rent-reminders/leases Error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
      const rejected = rejectBodyOrgId(body);
      if (rejected) {
        return NextResponse.json({ error: rejected }, { status: 400 });
      }

      const tenantName = typeof body.tenantName === 'string' ? body.tenantName.trim() : '';
      const sourceRef =
        (typeof body.sourceRef === 'string' && body.sourceRef.trim()) ||
        `manual-${Date.now()}`;
      if (!tenantName) {
        return NextResponse.json({ error: 'tenantName is required' }, { status: 400 });
      }

      const payload = {
        tenant_name: tenantName,
        tenant_phone: typeof body.tenantPhone === 'string' ? body.tenantPhone.trim() : null,
        tenant_email: typeof body.tenantEmail === 'string' ? body.tenantEmail.trim() : null,
        property_address: typeof body.propertyAddress === 'string' ? body.propertyAddress.trim() : null,
        unit_number: typeof body.unitNumber === 'string' ? body.unitNumber.trim() : null,
        rent_amount: typeof body.rentAmount === 'number' ? body.rentAmount : Number(body.rentAmount) || null,
        currency: typeof body.currency === 'string' ? body.currency : 'INR',
        due_day: typeof body.dueDay === 'number' ? body.dueDay : Number(body.dueDay) || 1,
      };

      const res = await client.query(
        `INSERT INTO pm_leases (org_id, source, source_ref, unit_ref, tenant_ref, status, payload)
         VALUES ($1, 'manual', $2, $3, $4, 'active', $5::jsonb)
         ON CONFLICT (org_id, source, source_ref)
         DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW(), status = 'active'
         RETURNING id, source, source_ref, unit_ref, tenant_ref, status, payload, created_at`,
        [
          orgId,
          sourceRef,
          typeof body.unitId === 'string' ? body.unitId : payload.unit_number || 'default',
          tenantName,
          JSON.stringify(payload),
        ]
      );

      return NextResponse.json({ lease: res.rows[0], invented: false }, { status: 201 });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    const message = err instanceof Error ? err.message : String(err);
    if (missingTables(message)) {
      return NextResponse.json({ error: '015_packs.sql not applied', invented: false }, { status: 503 });
    }
    console.error('POST /api/rent-reminders/leases', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
