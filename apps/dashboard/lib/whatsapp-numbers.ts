import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { providerIdOf, stopEvolutionInstance } from '@darex/whatsapp-gateway';
import { auditConnectorChange } from '@/lib/connector-rbac';
import { upsertOrgConnector } from '@/lib/connector-registry';

/**
 * An org can link several WhatsApp numbers. Each is one `channels` row with
 * channel_type 'whatsapp'; the first has account_key '' (the "primary"), extra
 * ones get a short random key. A route names a number with `channelId`; without
 * one it means the primary, so single-number callers behave as before.
 */

export type WhatsAppChannelRow = {
  id: string;
  account_key: string;
  status: string;
  meta: Record<string, unknown>;
  connected_at: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isChannelId(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

/** Short key for an extra number's channel row and Evolution instance. */
export function newAccountKey(): string {
  return `n${randomBytes(3).toString('hex')}`;
}

/** The org's WhatsApp rows, primary first. Disconnected extras are dropped. */
export async function listWhatsAppChannels(client: PoolClient, orgId: string): Promise<WhatsAppChannelRow[]> {
  const res = await client.query(
    `SELECT id, account_key, status, meta, connected_at FROM channels
      WHERE org_id = $1 AND channel_type = 'whatsapp'
        AND (account_key = '' OR status <> 'disconnected')
      ORDER BY (account_key = '') DESC, created_at ASC`,
    [orgId]
  );
  return res.rows as WhatsAppChannelRow[];
}

/** The row a request means: the named channel of this org, else the primary. */
export async function findWhatsAppChannel(
  client: PoolClient,
  orgId: string,
  channelId?: string | null
): Promise<WhatsAppChannelRow | undefined> {
  const res = channelId
    ? await client.query(
        `SELECT id, account_key, status, meta, connected_at FROM channels
          WHERE org_id = $1 AND channel_type = 'whatsapp' AND id = $2`,
        [orgId, channelId]
      )
    : await client.query(
        `SELECT id, account_key, status, meta, connected_at FROM channels
          WHERE org_id = $1 AND channel_type = 'whatsapp' AND account_key = ''`,
        [orgId]
      );
  return res.rows[0] as WhatsAppChannelRow | undefined;
}

/**
 * Where a new connection is stored: an existing number (`channelId`), a new
 * extra number (`add`), or the primary.
 */
export async function resolveConnectSlot(
  client: PoolClient,
  orgId: string,
  opts: { channelId?: string | null; add?: boolean }
): Promise<{ ok: true; accountKey: string } | { ok: false; message: string }> {
  if (opts.channelId) {
    const row = await findWhatsAppChannel(client, orgId, opts.channelId);
    if (!row) return { ok: false, message: 'That WhatsApp number was not found.' };
    return { ok: true, accountKey: row.account_key };
  }
  if (opts.add) return { ok: true, accountKey: newAccountKey() };
  return { ok: true, accountKey: '' };
}

/** What the browser may see about one number (never a token). */
export function publicWhatsAppNumber(row: WhatsAppChannelRow) {
  const meta = row.meta || {};
  const provider = providerIdOf(meta);
  const shown = meta.display_phone_number || meta.linked_phone;
  return {
    id: row.id,
    primary: row.account_key === '',
    provider,
    connected: row.status === 'connected' || row.status === 'active',
    pairing: row.status === 'pairing',
    phone: typeof shown === 'string' && shown ? shown : null,
    name: typeof meta.verified_name === 'string' && meta.verified_name
      ? meta.verified_name
      : typeof meta.profile_name === 'string' && meta.profile_name ? meta.profile_name : null,
  };
}

/**
 * When the primary number is not linked but an extra one is, make the extra the
 * primary (swap the two rows' account_key) so the card, the connector status and
 * every default-number route keep working. Returns true when it swapped.
 */
export async function promoteWhatsAppPrimary(client: PoolClient, orgId: string): Promise<boolean> {
  const rows = await client.query(
    `SELECT id, account_key, status FROM channels
      WHERE org_id = $1 AND channel_type = 'whatsapp' ORDER BY (account_key = '') DESC, created_at ASC`,
    [orgId]
  );
  const primary = rows.rows.find((r: { account_key: string }) => r.account_key === '');
  if (!primary || primary.status === 'connected' || primary.status === 'active') return false;
  const next = rows.rows.find(
    (r: { account_key: string; status: string }) => r.account_key !== '' && (r.status === 'connected' || r.status === 'active')
  );
  if (!next) return false;
  // Three steps because (org_id, channel_type, account_key) is unique.
  await client.query(`UPDATE channels SET account_key = $3 WHERE org_id = $1 AND id = $2`, [orgId, primary.id, `old${primary.id.slice(0, 6)}`]);
  await client.query(`UPDATE channels SET account_key = '' WHERE org_id = $1 AND id = $2`, [orgId, next.id]);
  await client.query(`UPDATE channels SET account_key = $3 WHERE org_id = $1 AND id = $2`, [orgId, primary.id, next.account_key]);
  return true;
}

/**
 * Unlink one number: stop its Evolution session if it has one, clear the row
 * (kept, because conversations point at it) and audit. The org-level connector
 * only turns disconnected when no other number is still linked.
 */
export async function disconnectWhatsAppNumber(
  client: PoolClient,
  orgId: string,
  userId: string,
  row: WhatsAppChannelRow
): Promise<{ ok: true } | { ok: false; message: string }> {
  const provider = providerIdOf(row.meta);
  if (provider === 'evolution' && typeof row.meta?.evolution_instance === 'string') {
    const stopped = await stopEvolutionInstance(row.meta.evolution_instance);
    if (!stopped.ok) return { ok: false, message: stopped.message };
  }
  await client.query(
    `UPDATE channels SET status = 'disconnected', meta = '{}'::jsonb, connected_at = NULL
      WHERE org_id = $1 AND id = $2`,
    [orgId, row.id]
  );
  const promoted = row.account_key === '' && (await promoteWhatsAppPrimary(client, orgId));
  const others = await client.query(
    `SELECT 1 FROM channels WHERE org_id = $1 AND channel_type = 'whatsapp' AND id <> $2
        AND status IN ('connected', 'active')`,
    [orgId, row.id]
  );
  if (!others.rowCount && !promoted) {
    await upsertOrgConnector(client, orgId, 'whatsapp', {
      status: 'disconnected',
      nangoConnectionId: null,
      scopes: [],
      lastOkAt: null,
      lastError: null,
    });
  }
  await auditConnectorChange(client, {
    orgId,
    kind: 'connector.disconnect',
    actor: { actorType: 'user', userId },
    tool: 'whatsapp',
    action: provider === 'evolution' ? 'disconnect_qr' : 'disconnect',
    resultStatus: 'ok',
    payload: { accountId: row.account_key || 'primary', authMode: provider === 'evolution' ? 'qr' : 'byok' },
  });
  return { ok: true };
}
