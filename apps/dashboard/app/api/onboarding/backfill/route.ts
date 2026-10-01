import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { clampBackfillWindow, mapBackfillRow } from '@/lib/onboarding-rollout';
import { runConversationBackfill } from '@/lib/onboarding-observation-query';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT id, window_days, status, loops_imported, won_imported, error, started_at, finished_at
         FROM org_backfill_jobs WHERE org_id = $1 ORDER BY created_at DESC LIMIT 5`,
        [orgId]
      );
      return NextResponse.json({ orgId, jobs: res.rows.map(mapBackfillRow) });
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth = scopedAuthErrorResponse(err);
    if (__scopedAuth) return __scopedAuth;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { client, orgId, userId } = await getScopedClient();
    try {
      const role = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const body = (await request.json().catch(() => ({}))) as {
        windowDays?: number;
        orgId?: string;
        org_id?: string;
      };
      if (body.orgId || body.org_id) {
        return NextResponse.json(
          { error: 'org_id is not accepted from the client; it is resolved from the session.' },
          { status: 400 }
        );
      }
      const windowDays = clampBackfillWindow(body.windowDays);
      const job = await client.query(
        `INSERT INTO org_backfill_jobs (org_id, window_days, status, started_at)
         VALUES ($1, $2, 'running', NOW()) RETURNING id`,
        [orgId, windowDays]
      );
      const jobId = job.rows[0].id;
      try {
        const result = await runConversationBackfill(client, orgId, windowDays);
        const done = await client.query(
          `UPDATE org_backfill_jobs
           SET status = 'completed', loops_imported = $2, won_imported = $3, finished_at = NOW()
           WHERE id = $1 AND org_id = $4
           RETURNING id, window_days, status, loops_imported, won_imported, error, started_at, finished_at`,
          [jobId, result.loopsImported, result.wonImported, orgId]
        );
        return NextResponse.json({ orgId, job: mapBackfillRow(done.rows[0]), chased: false });
      } catch (inner) {
        await client.query(
          `UPDATE org_backfill_jobs
           SET status = 'failed', error = $2, finished_at = NOW()
           WHERE id = $1 AND org_id = $3`,
          [jobId, inner instanceof Error ? inner.message : 'backfill failed', orgId]
        );
        throw inner;
      }
    } finally {
      client.release();
    }
  } catch (err) {
    const __scopedAuth2 = scopedAuthErrorResponse(err);
    if (__scopedAuth2) return __scopedAuth2;
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
