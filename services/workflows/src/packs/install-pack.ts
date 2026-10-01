/**
 * Canonical pack install / uninstall (shared by Temporal + dashboard HTTP).
 * Session/workflow org only — never body org_id.
 * Keep employee templates aligned with packs/{id}/pack.yaml via manifests.ts.
 */

import type { PoolClient } from 'pg';
import type { InstallPackWorkflowResult, PackInstallState } from '@darex/shared-types';
import { PACK_INSTALL_STATES } from '@darex/shared-types';
import { isLivePackId, PACK_MANIFESTS } from './manifests.js';

export { isLivePackId, LIVE_PACK_IDS } from './manifests.js';

export const PACK_MANIFEST_VERSION = '1.0.0';

export function asInstallState(value: string): PackInstallState {
  if ((PACK_INSTALL_STATES as readonly string[]).includes(value)) {
    return value as PackInstallState;
  }
  return 'pending';
}

async function seedEmployees(
  client: PoolClient,
  orgId: string,
  packId: string,
  opts?: { upgrade?: boolean }
): Promise<{ seeded: number; upgraded: number; skippedConflicts: string[] }> {
  const manifest = PACK_MANIFESTS[packId];
  if (!manifest) return { seeded: 0, upgraded: 0, skippedConflicts: [] };

  let seeded = 0;
  let upgraded = 0;
  const skippedConflicts: string[] = [];

  for (const emp of manifest.employees) {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM ai_employees WHERE org_id = $1 AND lower(name) = lower($2) LIMIT 1`,
      [orgId, emp.name]
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      let packAttr: string | null = null;
      try {
        const packRes = await client.query<{ pack_id: string | null }>(
          `SELECT pack_id FROM ai_employees WHERE id = $1`,
          [row.id]
        );
        packAttr = packRes.rows[0]?.pack_id ?? null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/pack_id|column/i.test(message)) throw err;
        packAttr = null;
      }
      if (opts?.upgrade && (packAttr === packId || packAttr == null)) {
        const persona = JSON.stringify({
          text: emp.personaTemplate,
          rosterKey: emp.name.toLowerCase(),
          packId,
        });
        try {
          await client.query(
            `UPDATE ai_employees
                SET role = $3,
                    persona = $4::jsonb,
                    tool_allowlist = $5,
                    pack_id = $6,
                    updated_at = NOW()
              WHERE id = $1 AND org_id = $2`,
            [row.id, orgId, emp.role, persona, emp.toolAllowlist, packId]
          );
          upgraded += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/pack_id/i.test(message)) {
            await client.query(
              `UPDATE ai_employees
                  SET role = $3, persona = $4::jsonb, tool_allowlist = $5, updated_at = NOW()
                WHERE id = $1 AND org_id = $2`,
              [row.id, orgId, emp.role, persona, emp.toolAllowlist]
            );
            upgraded += 1;
          } else {
            throw err;
          }
        }
      } else if (packAttr && packAttr !== packId) {
        skippedConflicts.push(emp.name);
      }
      continue;
    }

    const persona = JSON.stringify({
      text: emp.personaTemplate,
      rosterKey: emp.name.toLowerCase(),
      packId,
    });
    try {
      await client.query(
        `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, graph_id, status, pack_id)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'active', $7)`,
        [
          orgId,
          emp.name,
          emp.role,
          persona,
          emp.toolAllowlist,
          `pack-${packId}-${emp.name.toLowerCase()}`,
          packId,
        ]
      );
      seeded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/pack_id/i.test(message)) throw err;
      await client.query(
        `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, graph_id, status)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'active')`,
        [
          orgId,
          emp.name,
          emp.role,
          persona,
          emp.toolAllowlist,
          `pack-${packId}-${emp.name.toLowerCase()}`,
        ]
      );
      seeded += 1;
    }
  }
  return { seeded, upgraded, skippedConflicts };
}

async function recommendDisconnected(client: PoolClient, orgId: string, packId: string): Promise<void> {
  const manifest = PACK_MANIFESTS[packId];
  if (!manifest) return;
  const keys = [...manifest.connectors.recommended, ...manifest.connectors.optional];
  for (const key of keys) {
    const def = await client.query(`SELECT key FROM connector_defs WHERE key = $1 LIMIT 1`, [key]);
    if (!def.rows[0]) continue;
    await client.query(
      `INSERT INTO org_connectors (org_id, connector_key, status)
       VALUES ($1, $2, 'disconnected')
       ON CONFLICT (org_id, connector_key, account_id) DO NOTHING`,
      [orgId, key]
    );
  }
}

async function writePackAudit(
  client: PoolClient,
  orgId: string,
  userId: string | null,
  kind: 'pack.install' | 'pack.uninstall' | 'pack.upgrade' | 'pack.config_update',
  packId: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO audit_events (org_id, kind, actor_type, actor_user_id, result_status, payload)
       VALUES ($1, $2, 'user', $3, 'ok', $4::jsonb)`,
      [orgId, kind, userId, JSON.stringify({ packId, ...payload })]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/audit_events|kind_chk|does not exist/i.test(message)) {
      console.warn('[packs] audit_events write skipped:', message.slice(0, 120));
      return;
    }
    throw err;
  }
}

export async function installPackForOrg(
  client: PoolClient,
  orgId: string,
  packId: string,
  opts?: { userId?: string | null }
): Promise<InstallPackWorkflowResult & { skippedConflicts?: string[] }> {
  if (!isLivePackId(packId)) {
    return { orgId, packId, status: 'failed', noop: false };
  }
  const manifest = PACK_MANIFESTS[packId];
  if (!manifest) {
    return { orgId, packId, status: 'failed', noop: false };
  }

  if (manifest.extends && manifest.extends !== packId) {
    const parentResult = await installPackForOrg(client, orgId, manifest.extends, opts);
    if (parentResult.status === 'failed') return parentResult;
  }

  const existing = await client.query(
    `SELECT status FROM org_packs WHERE org_id = $1 AND pack_id = $2 FOR UPDATE`,
    [orgId, packId]
  );
  const prior = existing.rows[0]?.status ? asInstallState(String(existing.rows[0].status)) : null;
  if (prior === 'installed') {
    return { orgId, packId, status: 'installed', noop: true };
  }

  try {
    await client.query(
      `INSERT INTO org_packs (org_id, pack_id, status, is_primary, config, installed_version)
       VALUES ($1, $2, 'installing', $3, '{}'::jsonb, $4)
       ON CONFLICT (org_id, pack_id) DO UPDATE SET
         status = 'installing',
         uninstalled_at = NULL,
         updated_at = NOW()`,
      [orgId, packId, packId === 'core-b2b', PACK_MANIFEST_VERSION]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/installed_version/i.test(message)) throw err;
    await client.query(
      `INSERT INTO org_packs (org_id, pack_id, status, is_primary, config)
       VALUES ($1, $2, 'installing', $3, '{}'::jsonb)
       ON CONFLICT (org_id, pack_id) DO UPDATE SET
         status = 'installing',
         uninstalled_at = NULL,
         updated_at = NOW()`,
      [orgId, packId, packId === 'core-b2b']
    );
  }

  const seed = await seedEmployees(client, orgId, packId);
  try {
    await recommendDisconnected(client, orgId, packId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[packs] connector recommend skipped:', message.slice(0, 120));
  }

  try {
    await writePackMemory(client, orgId, packId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[packs] org_memory write skipped:', message.slice(0, 120));
  }

  try {
    await client.query(
      `UPDATE org_packs
          SET status = 'installed',
              installed_at = COALESCE(installed_at, NOW()),
              installed_version = $3,
              updated_at = NOW()
        WHERE org_id = $1 AND pack_id = $2`,
      [orgId, packId, PACK_MANIFEST_VERSION]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/installed_version/i.test(message)) throw err;
    await client.query(
      `UPDATE org_packs
          SET status = 'installed',
              installed_at = COALESCE(installed_at, NOW()),
              updated_at = NOW()
        WHERE org_id = $1 AND pack_id = $2`,
      [orgId, packId]
    );
  }

  await writePackAudit(client, orgId, opts?.userId ?? null, 'pack.install', packId, {
    seeded: seed.seeded,
    skippedConflicts: seed.skippedConflicts,
  });

  return {
    orgId,
    packId,
    status: 'installed',
    noop: false,
    skippedConflicts: seed.skippedConflicts,
  };
}

async function writePackMemory(client: PoolClient, orgId: string, packId: string): Promise<void> {
  const manifest = PACK_MANIFESTS[packId];
  if (!manifest) return;
  const body =
    manifest.onboardingCopy ||
    `${manifest.name} installed. Connectors stay disconnected until OAuth. Never invent source facts.`;
  const hash = `${manifest.id}:${manifest.version}:onboarding`;
  await client.query(
    `INSERT INTO org_memory (org_id, kind, title, body, source, source_ref, content_hash, metadata)
     VALUES ($1, 'sop', $2, $3, 'pack', $4, $5, $6::jsonb)
     ON CONFLICT (org_id, source, source_ref, content_hash) DO NOTHING`,
    [
      orgId,
      `${manifest.name} pack SOP`,
      body,
      manifest.id,
      hash,
      JSON.stringify({ packId: manifest.id, version: manifest.version }),
    ]
  );
}

/**
 * Re-apply pack employee prompts/tools for an already-installed pack (upgrade in place).
 */
export async function upgradePackForOrg(
  client: PoolClient,
  orgId: string,
  packId: string,
  opts?: { userId?: string | null }
): Promise<{
  orgId: string;
  packId: string;
  status: 'installed' | 'failed';
  upgraded: number;
  seeded: number;
  skippedConflicts: string[];
  version: string;
}> {
  if (!isLivePackId(packId)) {
    return {
      orgId,
      packId,
      status: 'failed',
      upgraded: 0,
      seeded: 0,
      skippedConflicts: [],
      version: PACK_MANIFEST_VERSION,
    };
  }
  const existing = await client.query(
    `SELECT status FROM org_packs WHERE org_id = $1 AND pack_id = $2 FOR UPDATE`,
    [orgId, packId]
  );
  if (!existing.rows[0] || asInstallState(String(existing.rows[0].status)) !== 'installed') {
    return {
      orgId,
      packId,
      status: 'failed',
      upgraded: 0,
      seeded: 0,
      skippedConflicts: [],
      version: PACK_MANIFEST_VERSION,
    };
  }

  const seed = await seedEmployees(client, orgId, packId, { upgrade: true });
  try {
    await recommendDisconnected(client, orgId, packId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[packs] connector recommend skipped on upgrade:', message.slice(0, 120));
  }

  try {
    await client.query(
      `UPDATE org_packs
          SET installed_version = $3,
              last_upgraded_at = NOW(),
              updated_at = NOW()
        WHERE org_id = $1 AND pack_id = $2`,
      [orgId, packId, PACK_MANIFEST_VERSION]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/installed_version|last_upgraded_at/i.test(message)) throw err;
    await client.query(
      `UPDATE org_packs SET updated_at = NOW() WHERE org_id = $1 AND pack_id = $2`,
      [orgId, packId]
    );
  }

  await writePackAudit(client, orgId, opts?.userId ?? null, 'pack.upgrade', packId, {
    upgraded: seed.upgraded,
    seeded: seed.seeded,
    skippedConflicts: seed.skippedConflicts,
    version: PACK_MANIFEST_VERSION,
  });

  return {
    orgId,
    packId,
    status: 'installed',
    upgraded: seed.upgraded,
    seeded: seed.seeded,
    skippedConflicts: seed.skippedConflicts,
    version: PACK_MANIFEST_VERSION,
  };
}

export async function updatePackConfig(
  client: PoolClient,
  orgId: string,
  packId: string,
  config: Record<string, unknown>,
  opts?: { userId?: string | null }
): Promise<{ packId: string; config: Record<string, unknown> } | null> {
  const res = await client.query<{ pack_id: string; config: Record<string, unknown> }>(
    `UPDATE org_packs
        SET config = config || $3::jsonb,
            updated_at = NOW()
      WHERE org_id = $1 AND pack_id = $2 AND status = 'installed'
      RETURNING pack_id, config`,
    [orgId, packId, JSON.stringify(config)]
  );
  if (!res.rows[0]) return null;
  await writePackAudit(client, orgId, opts?.userId ?? null, 'pack.config_update', packId, {
    config,
  });
  return { packId: res.rows[0].pack_id, config: res.rows[0].config };
}

export async function uninstallPackForOrg(
  client: PoolClient,
  orgId: string,
  packId: string,
  opts?: { userId?: string | null }
): Promise<{
  orgId: string;
  packId: string;
  status: 'uninstalled';
  conversationsDeleted: false;
}> {
  await client.query(
    `UPDATE org_packs
        SET status = 'uninstalled',
            is_primary = false,
            uninstalled_at = NOW(),
            updated_at = NOW()
      WHERE org_id = $1 AND pack_id = $2`,
    [orgId, packId]
  );
  // Soft-disable pack-attributed employees when pack_id column exists; never delete conversations.
  try {
    await client.query(
      `UPDATE ai_employees
          SET status = 'paused', updated_at = NOW()
        WHERE org_id = $1 AND pack_id = $2 AND status = 'active'`,
      [orgId, packId]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/pack_id/i.test(message)) throw err;
  }
  await writePackAudit(client, orgId, opts?.userId ?? null, 'pack.uninstall', packId, {});
  return { orgId, packId, status: 'uninstalled', conversationsDeleted: false };
}
