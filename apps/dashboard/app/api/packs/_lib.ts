/**
 * Pack install helpers for HTTP. Session org only — never body org_id.
 * Keep employee templates aligned with packs/{id}/pack.yaml.
 */

import type { PoolClient } from 'pg';
import type { InstallPackWorkflowResult, PackInstallState } from '@darex/shared-types';
import { PACK_INSTALL_STATES } from '@darex/shared-types';

export const LIVE_PACK_IDS = ['core-b2b', 'real-estate-brokerage'] as const;

type LivePackId = (typeof LIVE_PACK_IDS)[number];

export function isLivePackId(packId: string): packId is LivePackId {
  return (LIVE_PACK_IDS as readonly string[]).includes(packId);
}

export function rejectBodyOrgId(body: { orgId?: unknown; org_id?: unknown }): string | null {
  if (body.orgId || body.org_id) {
    return 'org_id is not accepted from the client; it is resolved from the session.';
  }
  return null;
}

function asInstallState(value: string): PackInstallState {
  if ((PACK_INSTALL_STATES as readonly string[]).includes(value)) {
    return value as PackInstallState;
  }
  return 'pending';
}

interface SeedEmployee {
  name: string;
  role: string;
  persona: string;
  tools: string[];
}

const EMPLOYEES: Record<LivePackId, SeedEmployee[]> = {
  'core-b2b': [
    {
      name: 'Sarah',
      role: 'Sales / front-of-house',
      persona: 'Enthusiastic sales specialist. Qualify leads, draft follow-ups, never invent pipeline amounts.',
      tools: ['gmail', 'whatsapp', 'hubspot', 'google-calendar', 'web_search'],
    },
    {
      name: 'Emma',
      role: 'Support / success',
      persona: 'Empathetic support agent. Answer from memory and tickets. Never invent order status.',
      tools: ['gmail', 'whatsapp', 'google-calendar'],
    },
    {
      name: 'Marcus',
      role: 'Ops / analyst',
      persona: 'Ops analyst. Sheets, Drive, and metrics.query only. Never invent KPIs.',
      tools: ['google-sheets', 'google-drive', 'metrics', 'web_search'],
    },
  ],
  'real-estate-brokerage': [
    {
      name: 'Aisha',
      role: 'Buyer ISA',
      persona: 'Qualify WhatsApp and portal leads. Filters first. Never invent inventory, price, or RERA.',
      tools: ['whatsapp', 'gmail', 'google-calendar', 're', 'google-sheets'],
    },
    {
      name: 'Kabir',
      role: 'Showing coordinator',
      persona: 'Book showings on Calendar when connected. Never invent a booked slot.',
      tools: ['google-calendar', 'whatsapp', 'gmail', 're'],
    },
    {
      name: 'Meera',
      role: 'Listing coordinator',
      persona: 'Listing checklist from source fields only. Never invent price, area, or RERA.',
      tools: ['google-drive', 'google-docs', 'gmail', 'google-sheets', 're'],
    },
  ],
};

const RECOMMENDED: Record<LivePackId, string[]> = {
  'core-b2b': ['gmail', 'whatsapp', 'google-calendar'],
  'real-estate-brokerage': ['google-sheets', 'whatsapp', 'gmail', 'google-calendar'],
};

const PARENT: Record<LivePackId, LivePackId | null> = {
  'core-b2b': null,
  'real-estate-brokerage': 'core-b2b',
};

async function seedEmployees(client: PoolClient, orgId: string, packId: LivePackId): Promise<number> {
  let seeded = 0;
  for (const emp of EMPLOYEES[packId]) {
    const existing = await client.query(
      `SELECT id FROM ai_employees WHERE org_id = $1 AND lower(name) = lower($2) LIMIT 1`,
      [orgId, emp.name]
    );
    if (existing.rows[0]) continue;
    await client.query(
      `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, graph_id, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'active')`,
      [
        orgId,
        emp.name,
        emp.role,
        JSON.stringify({ text: emp.persona, rosterKey: emp.name.toLowerCase(), packId }),
        emp.tools,
        `pack-${packId}-${emp.name.toLowerCase()}`,
      ]
    );
    seeded += 1;
  }
  return seeded;
}

async function recommendDisconnected(client: PoolClient, orgId: string, packId: LivePackId): Promise<void> {
  for (const key of RECOMMENDED[packId]) {
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

export async function installPackForOrg(
  client: PoolClient,
  orgId: string,
  packId: string
): Promise<InstallPackWorkflowResult> {
  if (!isLivePackId(packId)) {
    return { orgId, packId, status: 'failed', noop: false };
  }
  const parent = PARENT[packId];
  if (parent) {
    const parentResult = await installPackForOrg(client, orgId, parent);
    if (parentResult.status === 'failed') return parentResult;
  }

  const existing = await client.query(
    `SELECT status FROM org_packs WHERE org_id = $1 AND pack_id = $2 LIMIT 1`,
    [orgId, packId]
  );
  const prior = existing.rows[0]?.status ? asInstallState(String(existing.rows[0].status)) : null;
  if (prior === 'installed') {
    return { orgId, packId, status: 'installed', noop: true };
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

  await seedEmployees(client, orgId, packId);
  try {
    await recommendDisconnected(client, orgId, packId);
  } catch {
    // connector_defs / org_connectors may be missing on a partial migrate
  }

  await client.query(
    `UPDATE org_packs
        SET status = 'installed',
            installed_at = COALESCE(installed_at, NOW()),
            updated_at = NOW()
      WHERE org_id = $1 AND pack_id = $2`,
    [orgId, packId]
  );

  return { orgId, packId, status: 'installed', noop: false };
}

export async function uninstallPackForOrg(
  client: PoolClient,
  orgId: string,
  packId: string
): Promise<{ status: PackInstallState; conversationsDeleted: false }> {
  await client.query(
    `UPDATE org_packs
        SET status = 'uninstalled',
            is_primary = false,
            uninstalled_at = NOW(),
            updated_at = NOW()
      WHERE org_id = $1 AND pack_id = $2`,
    [orgId, packId]
  );
  return { status: 'uninstalled', conversationsDeleted: false };
}
