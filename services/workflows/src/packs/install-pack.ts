/**
 * Idempotent pack install / uninstall. Uninstall does not delete conversations.
 */

import type { PoolClient } from 'pg';
import type { InstallPackWorkflowResult, PackInstallState, PackManifest } from '@darex/shared-types';
import { PACK_INSTALL_STATES } from '@darex/shared-types';
import { isLivePackId, PACK_MANIFESTS } from './manifests.js';

export function asInstallState(value: string): PackInstallState {
  if ((PACK_INSTALL_STATES as readonly string[]).includes(value)) {
    return value as PackInstallState;
  }
  return 'pending';
}

async function seedEmployees(client: PoolClient, orgId: string, manifest: PackManifest): Promise<number> {
  let seeded = 0;
  for (const emp of manifest.employees) {
    const existing = await client.query(
      `SELECT id FROM ai_employees WHERE org_id = $1 AND lower(name) = lower($2) LIMIT 1`,
      [orgId, emp.name]
    );
    if (existing.rows[0]) continue;
    const persona = JSON.stringify({
      text: emp.personaTemplate,
      rosterKey: emp.name.toLowerCase(),
      packId: manifest.id,
    });
    await client.query(
      `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, graph_id, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'active')`,
      [
        orgId,
        emp.name,
        emp.role,
        persona,
        emp.toolAllowlist,
        `pack-${manifest.id}-${emp.name.toLowerCase()}`,
      ]
    );
    seeded += 1;
  }
  return seeded;
}

async function recommendConnectors(client: PoolClient, orgId: string, manifest: PackManifest): Promise<void> {
  const keys = [...manifest.connectors.recommended, ...manifest.connectors.optional];
  for (const key of keys) {
    const def = await client.query(`SELECT key FROM connector_defs WHERE key = $1 LIMIT 1`, [key]);
    if (!def.rows[0]) continue;
    await client.query(
      `INSERT INTO org_connectors (org_id, connector_key, status)
       VALUES ($1, $2, 'disconnected')
       ON CONFLICT (org_id, connector_key) DO NOTHING`,
      [orgId, key]
    );
  }
}

async function writePackMemory(client: PoolClient, orgId: string, manifest: PackManifest): Promise<void> {
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

export async function installPackForOrg(
  client: PoolClient,
  orgId: string,
  packId: string
): Promise<InstallPackWorkflowResult> {
  if (!isLivePackId(packId)) {
    return { orgId, packId, status: 'failed', noop: false };
  }
  const manifest = PACK_MANIFESTS[packId];
  if (!manifest) {
    return { orgId, packId, status: 'failed', noop: false };
  }

  if (manifest.extends && manifest.extends !== packId) {
    const parent = await installPackForOrg(client, orgId, manifest.extends);
    if (parent.status === 'failed') return parent;
  }

  const existing = await client.query(
    `SELECT status FROM org_packs WHERE org_id = $1 AND pack_id = $2 LIMIT 1`,
    [orgId, packId]
  );
  const prior = existing.rows[0]?.status ? asInstallState(String(existing.rows[0].status)) : null;
  switch (prior) {
    case 'installed':
      return { orgId, packId, status: 'installed', noop: true };
    case 'pending':
    case 'installing':
    case 'failed':
    case 'uninstalling':
    case 'disabled':
    case 'uninstalled':
    case null:
      break;
    default: {
      const _exhaustive: never = prior;
      void _exhaustive;
      break;
    }
  }

  await client.query(
    `INSERT INTO org_packs (org_id, pack_id, status, is_primary, config)
     VALUES ($1, $2, 'installing', $3, '{}'::jsonb)
     ON CONFLICT (org_id, pack_id) DO UPDATE SET
       status = 'installing',
       uninstalled_at = NULL,
       updated_at = NOW()`,
    [orgId, packId, packId === 'core-b2b']
  );

  await seedEmployees(client, orgId, manifest);
  await recommendConnectors(client, orgId, manifest);
  try {
    await writePackMemory(client, orgId, manifest);
  } catch {
    // org_memory may be missing on a partial migrate — pack install still succeeds
  }

  await client.query(
    `UPDATE org_packs
        SET status = 'installed',
            installed_at = COALESCE(installed_at, NOW()),
            is_primary = CASE WHEN $3 THEN true ELSE is_primary END,
            updated_at = NOW()
      WHERE org_id = $1 AND pack_id = $2`,
    [orgId, packId, packId === 'core-b2b']
  );

  return { orgId, packId, status: 'installed', noop: false };
}

export async function uninstallPackForOrg(
  client: PoolClient,
  orgId: string,
  packId: string
): Promise<{ orgId: string; packId: string; status: 'uninstalled'; conversationsDeleted: false }> {
  await client.query(
    `UPDATE org_packs
        SET status = 'uninstalled',
            is_primary = false,
            uninstalled_at = NOW(),
            updated_at = NOW()
      WHERE org_id = $1 AND pack_id = $2`,
    [orgId, packId]
  );
  return { orgId, packId, status: 'uninstalled', conversationsDeleted: false };
}
