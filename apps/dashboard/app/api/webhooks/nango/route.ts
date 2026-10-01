import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgScopedClient } from '@/lib/db';
import { assertNangoWebhookSignature } from '@/lib/webhook-crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NangoWebhookPayloadSchema = z.object({
  connectionId: z.string().optional(),
  connection_id: z.string().optional(),
  type: z.string().optional(),
  providerConfigKey: z.string().optional(),
  provider_config_key: z.string().optional(),
}).passthrough();

/**
 * POST /api/webhooks/nango — Nango connection lifecycle events.
 * Verified by X-Nango-Signature (NANGO_WEBHOOK_SECRET). 503 until the secret
 * is set — do not enable webhooks in the Nango UI before then.
 *
 * Connection IDs are `${orgId}_${provider}`, so the org resolves from the
 * event itself (never from body org_id, which is ignored).
 * Side effects are log-only: connection state stays lazily discovered via
 * resolveNangoAuth so a stray event can never disconnect an org.
 */
export async function POST(request: Request) {
  const rawBody = await request.text().catch(() => '');
  const sig = request.headers.get('x-nango-signature');
  const check = assertNangoWebhookSignature(rawBody, sig);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = NangoWebhookPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid webhook payload structure', details: parsed.error.flatten() }, { status: 400 });
  }

  const body = parsed.data;
  const connectionId = body.connectionId || body.connection_id || '';
  const type = body.type || 'unknown';
  const providerKey = body.providerConfigKey || body.provider_config_key || '';

  // connectionId format `${orgId}_${provider}` — orgId is a UUID prefix.
  const orgId = connectionId.length > 37 && connectionId[36] === '_' &&
    UUID_RE.test(connectionId.slice(0, 36))
    ? connectionId.slice(0, 36)
    : null;
  if (!orgId) {
    // Ack (avoid Nango retries) but record nothing — unresolvable tenant.
    return NextResponse.json({ ok: true, logged: false });
  }

  try {
    const { client } = await getOrgScopedClient(orgId);
    try {
      await client.query(
        `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
         VALUES ($1, $2, 'nango_webhook', 'success', 200, $3, $4)`,
        [
          orgId,
          String(providerKey || 'nango').slice(0, 100),
          `Nango webhook: ${String(type).slice(0, 100)} for ${connectionId.slice(0, 100)}`,
          JSON.stringify({ type, connectionId, providerConfigKey: providerKey }).slice(0, 2000),
        ]
      );
    } finally {
      client.release();
    }
  } catch (e: unknown) {
    console.error('[nango-webhook] log failed:', e instanceof Error ? e.message : e);
  }
  return NextResponse.json({ ok: true, logged: true });
}
