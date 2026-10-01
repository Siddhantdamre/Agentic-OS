import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/stream/push-subscribe
 * Store a Web Push subscription for the session user/org.
 * Delivery only runs when VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY are set
 * (see lib/web-push-notify.ts) — no fake notifications are invented.
 */
export async function POST(request: Request) {
  let client;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId, userId } = scoped;

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.orgId != null || body.org_id != null) {
      return NextResponse.json({ error: 'org_id must not be supplied in body' }, { status: 400 });
    }

    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    const keys =
      body.keys && typeof body.keys === 'object'
        ? (body.keys as Record<string, unknown>)
        : {};
    const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : typeof body.p256dh === 'string' ? body.p256dh : '';
    const auth = typeof keys.auth === 'string' ? keys.auth : typeof body.auth === 'string' ? body.auth : '';

    if (!endpoint || !endpoint.startsWith('https://')) {
      return NextResponse.json({ error: 'endpoint must be an https URL' }, { status: 400 });
    }
    if (!p256dh || !auth) {
      return NextResponse.json({ error: 'keys.p256dh and keys.auth are required' }, { status: 400 });
    }

    const userAgent = request.headers.get('user-agent')?.slice(0, 500) ?? null;

    await client.query(
      `INSERT INTO web_push_subscriptions (
         org_id, user_id, endpoint, p256dh, auth, user_agent, updated_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, NOW())
       ON CONFLICT (org_id, endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             user_agent = EXCLUDED.user_agent,
             updated_at = NOW()`,
      [orgId, userId, endpoint, p256dh, auth, userAgent]
    );

    const vapidConfigured = Boolean(
      process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim()
    );

    return NextResponse.json({
      ok: true,
      vapidConfigured,
      message: vapidConfigured
        ? 'Subscription stored; needs_attention will attempt Web Push delivery.'
        : 'Subscription stored; delivery paused until VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const __scopedAuth = scopedAuthErrorResponse(err instanceof Error ? err : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    if (/web_push_subscriptions|relation .* does not exist/i.test(message)) {
      return NextResponse.json(
        { error: 'Push table missing — apply migration 103' },
        { status: 503 }
      );
    }
    console.error('[push-subscribe] error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    client?.release();
  }
}

/** DELETE /api/stream/push-subscribe — remove this browser's endpoint. */
export async function DELETE(request: Request) {
  let client;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const { orgId, userId } = scoped;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) {
      return NextResponse.json({ error: 'endpoint is required' }, { status: 400 });
    }
    await client.query(
      `DELETE FROM web_push_subscriptions
        WHERE org_id = $1::uuid AND user_id = $2::uuid AND endpoint = $3`,
      [orgId, userId, endpoint]
    );
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const __scopedAuth2 = scopedAuthErrorResponse(err instanceof Error ? err : new Error(message));
    if (__scopedAuth2) return __scopedAuth2;
    console.error('[push-subscribe] delete error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  } finally {
    client?.release();
  }
}
