import type { PoolClient } from 'pg';
import { getEvolutionOwner } from '@darex/whatsapp-gateway';
import { auditConnectorChange } from '@/lib/connector-rbac';
import { upsertOrgConnector } from '@/lib/connector-registry';

/**
 * Mark one QR-linked WhatsApp number (a `channels` row) connected. Idempotent:
 * called by both the status poll and the Evolution CONNECTION_UPDATE webhook.
 * `userId` is null when the webhook (not a person) observed the link.
 */
export async function markWhatsAppQrConnected(
  client: PoolClient,
  orgId: string,
  userId: string | null,
  channelId: string
): Promise<void> {
  const res = await client.query(
    `UPDATE channels SET status = 'connected', connected_at = NOW()
      WHERE org_id = $1 AND id = $2 AND channel_type = 'whatsapp'
        AND meta->>'provider' = 'evolution' AND status <> 'connected'
      RETURNING meta->>'evolution_instance' AS instance, account_key`,
    [orgId, channelId]
  );
  if (!res.rowCount) return;
  const instance = res.rows[0].instance as string | undefined;
  const accountKey = (res.rows[0].account_key as string) || 'primary';
  // Remember which number was linked so the card can show it (best effort).
  if (instance) {
    const owner = await getEvolutionOwner(instance);
    if (owner.phone || owner.profileName) {
      await client.query(
        `UPDATE channels SET meta = meta || jsonb_build_object('linked_phone', $3::text, 'profile_name', $4::text)
          WHERE org_id = $1 AND id = $2`,
        [orgId, channelId, owner.phone, owner.profileName]
      );
    }
  }
  await client.query(
    `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message)
     VALUES ($1, 'whatsapp', 'connect', 'success', 200, 'WhatsApp linked by QR (Evolution)')`,
    [orgId]
  );
  await upsertOrgConnector(client, orgId, 'whatsapp', {
    status: 'connected',
    nangoConnectionId: null,
    scopes: ['whatsapp_qr'],
    lastOkAt: new Date(),
    lastError: null,
  });
  await auditConnectorChange(client, {
    orgId,
    kind: 'connector.connect',
    actor: userId ? { actorType: 'user', userId } : { actorType: 'system', component: 'whatsapp-evolution-webhook' },
    tool: 'whatsapp',
    action: 'connect_qr',
    resultStatus: 'ok',
    payload: { accountId: accountKey, authMode: 'qr' },
  });
}

/** WhatsApp logged out or the session was removed on the phone. */
export async function markWhatsAppQrDisconnected(client: PoolClient, orgId: string, channelId: string): Promise<void> {
  const res = await client.query(
    `UPDATE channels SET status = 'pairing', connected_at = NULL
      WHERE org_id = $1 AND id = $2 AND channel_type = 'whatsapp'
        AND meta->>'provider' = 'evolution' AND status = 'connected'
      RETURNING id`,
    [orgId, channelId]
  );
  if (!res.rowCount) return;
  await client.query(
    `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message)
     VALUES ($1, 'whatsapp', 'disconnect', 'error', 0, 'WhatsApp (QR) session closed - scan the QR again')`,
    [orgId]
  );
}
