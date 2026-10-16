import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

function slugPlaybookId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `org.${slug || 'playbook'}`;
}

export async function POST(request: Request) {
  try {
    const body = (await jsonBodyOrEmpty(request)) as Record<string, unknown>;
    if (body.org_id !== undefined || body.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted from the request body' }, { status: 400 });
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 3 || name.length > 80) {
      return NextResponse.json({ error: 'name must be 3–80 characters' }, { status: 400 });
    }

    const steps = Array.isArray(body.steps) ? body.steps : [];
    const summary = typeof body.summary === 'string' ? body.summary : '';
    const shapeKey = typeof body.shapeKey === 'string' ? body.shapeKey : name;
    const playbookId = typeof body.playbookId === 'string' && body.playbookId.startsWith('org.')
      ? body.playbookId
      : slugPlaybookId(shapeKey || name);
    const planId = typeof body.planId === 'string' ? body.planId : null;
    const workItemId = typeof body.workItemId === 'string' ? body.workItemId : null;

    const { client, orgId, userId } = await getScopedClient();
    try {
      const inserted = await client.query<{ id: string; playbook_id: string }>(
        `INSERT INTO org_playbook_promotions (
           org_id, playbook_id, name, plan_id, steps, summary, named_by_user_id
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         RETURNING id, playbook_id`,
        [orgId, playbookId, name, planId, JSON.stringify(steps), summary, userId]
      );

      if (workItemId) {
        await client.query(
          `UPDATE work_items
              SET status = 'done',
                  metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
                  updated_at = NOW()
            WHERE id = $1 AND org_id = $2`,
          [workItemId, orgId, JSON.stringify({ promotedPlaybookId: playbookId })]
        );
      }

      return NextResponse.json({
        ok: true,
        playbook: inserted.rows[0],
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const __scopedAuth = scopedAuthErrorResponse(error instanceof Error ? error : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    if (/org_playbook_promotions_org_id|duplicate key/i.test(message)) {
      return NextResponse.json({ error: 'playbook already exists' }, { status: 409 });
    }
    console.error('POST /api/work-items/playbook Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
