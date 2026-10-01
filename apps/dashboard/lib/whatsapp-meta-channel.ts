import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { pingWhatsApp } from '@darex/connectors';
import { providerIdOf, sealSecret, secretHint, secretsKeyConfigured, stopEvolutionInstance } from '@darex/whatsapp-gateway';
import { auditConnectorChange } from '@/lib/connector-rbac';
import { upsertOrgConnector } from '@/lib/connector-registry';
import { resolveConnectSlot } from '@/lib/whatsapp-numbers';

/**
 * Verify Meta Cloud credentials and save them as the org's WhatsApp channel.
 * Shared by the paste-a-token route and the Embedded Signup route so both end
 * in the same state (provider `meta-cloud`, a QR link unlinked first, audited).
 */
export async function saveMetaCloudChannel(
  client: PoolClient,
  input: {
    orgId: string;
    userId: string;
    accessToken: string;
    phoneNumberId: string;
    wabaId?: string;
    authMode: 'byok' | 'embedded_signup';
    /** Replace this number. */
    channelId?: string | null;
    /** Link as an extra number instead of replacing the primary. */
    add?: boolean;
  }
): Promise<NextResponse> {
  const { orgId, userId, accessToken, phoneNumberId, wabaId, authMode } = input;
  // The token is stored encrypted; refuse to save one we could not protect.
  if (!secretsKeyConfigured()) {
    return NextResponse.json(
      { success: false, connected: false, message: 'Token storage is not set up on this server (CHANNEL_SECRETS_KEY).' },
      { status: 503 }
    );
  }
  const ping = await pingWhatsApp({ accessToken, phoneNumberId });
  if (!ping.ok) {
    await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, 'whatsapp', 'connect', 'error', $2, $3, $4)`,
      [orgId, ping.status, ping.message, JSON.stringify({ phoneNumberId })]
    );
    return NextResponse.json(
      {
        success: false,
        connected: false,
        message: ping.message,
        setupUrl: '/connectors',
      },
      { status: ping.status === 401 || ping.status === 400 ? 400 : 502 }
    );
  }

  // The same phone number id always lands on its own row; else the asked slot.
  const same = await client.query(
    `SELECT account_key FROM channels
      WHERE org_id = $1 AND channel_type = 'whatsapp' AND meta->>'phone_number_id' = $2`,
    [orgId, phoneNumberId]
  );
  let accountKey: string;
  if (same.rows[0]) {
    accountKey = same.rows[0].account_key as string;
  } else {
    const slot = await resolveConnectSlot(client, orgId, { channelId: input.channelId, add: input.add });
    if (!slot.ok) return NextResponse.json({ success: false, connected: false, message: slot.message }, { status: 404 });
    accountKey = slot.accountKey;
  }

  // Replacing a QR-linked number: unlink it first so it stops receiving.
  const prior = await client.query(
    `SELECT meta FROM channels WHERE org_id = $1 AND channel_type = 'whatsapp' AND account_key = $2`,
    [orgId, accountKey]
  );
  const priorMeta = prior.rows[0]?.meta as Record<string, unknown> | undefined;
  if (providerIdOf(priorMeta) === 'evolution' && typeof priorMeta?.evolution_instance === 'string') {
    const stopped = await stopEvolutionInstance(priorMeta.evolution_instance);
    if (!stopped.ok) {
      return NextResponse.json({ success: false, connected: false, message: stopped.message }, { status: 502 });
    }
  }

  // Both legacy key names hold the same sealed value; token_hint is safe to show.
  const sealed = sealSecret(accessToken);
  const phoneInfo = (ping.data ?? {}) as { display_phone_number?: unknown; verified_name?: unknown };
  const metaPayload = JSON.stringify({
    provider: 'meta-cloud',
    accessToken: sealed,
    phoneNumberId,
    wabaId,
    phone_number_id: phoneNumberId,
    whatsapp_business_account_id: wabaId,
    meta_access_token: sealed,
    token_hint: secretHint(accessToken),
    display_phone_number: typeof phoneInfo.display_phone_number === 'string' ? phoneInfo.display_phone_number : null,
    verified_name: typeof phoneInfo.verified_name === 'string' ? phoneInfo.verified_name : null,
    verifiedAt: new Date().toISOString(),
  });

  const saved = await client.query(
    `INSERT INTO channels (org_id, channel_type, account_key, status, meta, connected_at)
     VALUES ($1, 'whatsapp', $3, 'connected', $2::jsonb, NOW())
     ON CONFLICT (org_id, channel_type, account_key)
     DO UPDATE SET status = 'connected',
       meta = (COALESCE(channels.meta, '{}'::jsonb) - 'evolution_instance' - 'evolution_mode') || $2::jsonb,
       connected_at = NOW()
     RETURNING id`,
    [orgId, metaPayload, accountKey]
  );

  await client.query(
    `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
     VALUES ($1, 'whatsapp', 'connect', 'success', 200, $2, $3)`,
    [orgId, authMode === 'embedded_signup' ? 'WhatsApp connected through Meta Embedded Signup' : 'WhatsApp manually connected via System User Token', JSON.stringify({ phoneNumberId })]
  );

  await upsertOrgConnector(client, orgId, 'whatsapp', {
    status: 'connected',
    nangoConnectionId: null,
    scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
    lastOkAt: new Date(),
    lastError: null,
  });

  await auditConnectorChange(client, {
    orgId,
    kind: 'connector.connect',
    actor: { actorType: 'user', userId },
    tool: 'whatsapp',
    action: `connect_${authMode}`,
    resultStatus: 'ok',
    payload: { accountId: accountKey || 'primary', authMode },
  });

  return NextResponse.json({
    success: true,
    connected: true,
    channelId: saved.rows[0]?.id as string | undefined,
    message: 'WhatsApp connected successfully',
    phone: ping.data,
  });
}
