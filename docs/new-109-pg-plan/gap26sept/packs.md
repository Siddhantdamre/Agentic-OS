# Packs Audit

## Status: done (dashboard packs + shared workflows installer)

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | No dashboard packs UI | P1 | `(dashboard)/packs/page.tsx`, AppShell `/packs` | 🟢 Done | Marketplace with install/upgrade/configure/uninstall |
| 2 | Missing RBAC on pack install/uninstall | P1 | `api/packs/route.ts` | 🟢 Done | owner/admin via `canManageOrgSettings` |
| 3 | Non-transactional pack install | P0 | `api/packs/route.ts` | 🟢 Done | BEGIN/COMMIT/ROLLBACK + FOR UPDATE |
| 4 | Duplicated install logic vs workflows | P0 | `api/packs/_lib.ts` vs `workflows/packs/install-pack.ts` | 🟢 Done | Dashboard `_lib` re-exports canonical installer from `@darex/workflows`; Temporal uses the same module. |
| 5 | Onboarding recommends uninstallable `ecommerce` | P0 | `(onboarding)/pack-recommendations.ts` + `api/org/create` | 🟢 Done | No live `ecommerce` id in `LIVE_PACK_IDS` (DB row is RFC/`live=false`). E-commerce & retail maps to installable `core-b2b`. `POST /api/org/create` calls `installPackForOrg` from packs `_lib` (same path as marketplace) — no HTTP self-fetch, no fake install success for draft ids |
| 6 | Pack attribution / config editor / upgrade engine | P2 | `104_billing_packs_gaps.sql`, `_lib.ts`, `api/packs/[id]/config` | 🟢 Done | `ai_employees.pack_id`, `installed_version`, upgrade action, PATCH config, UI buttons |

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Two Installable Live Packs with Real Database Writes**:
   - `services/workflows/src/packs/install-pack.ts:81-151` and `apps/dashboard/app/api/packs/_lib.ts:130-180` — `installPackForOrg` queries `org_packs` for prior installations and safely returns existing records if already installed.
   - Accurately seeds `ai_employees` only if a case-insensitive name match does not already exist (`dedup check`, `_lib.ts:20-23` and `install-pack.ts:35-38`).
   - Populates `org_connectors` as `disconnected` for recommended connectors, strictly avoiding false claims of OAuth connectivity.
   - Inserts standard operating procedures into `org_memory` (`writePackMemory`, `_lib.ts:61-79`).
   - Gated by `LIVE_PACK_IDS = ['core-b2b', 'real-estate-brokerage']`. Unlisted packs are rejected with explicit HTTP 400 errors (`apps/dashboard/app/api/packs/route.ts:69-78`).
2. **Recursive Parent Pack Chaining**:
   - `manifests.ts:80` and `install-pack.ts:94-97` — `real-estate-brokerage` declares `extends: 'core-b2b'`.
   - The installer recursively executes installation for the base `core-b2b` pack first, verifying completion before applying industry-specific extensions.
3. **Tenant Isolation on Pack Mutations**:
   - `apps/dashboard/app/api/packs/route.ts:7-130` — `GET`, `POST`, and `DELETE` routes enforce `rejectBodyOrgId`, resolving tenant context exclusively from the verified user session via `getScopedClient()`.
4. **Clean API Alias for Onboarding**:
   - `apps/dashboard/app/api/packs/install/route.ts:1-6` — Exports `POST = install` directly from `../route.ts`, providing a dedicated endpoint consumed by `POST /api/org/create` without duplicating route logic.
5. **Honest Onboarding Recommendations**:
   - `apps/dashboard/app/(onboarding)/pack-recommendations.ts:9-13` — Recommends connectors with hardcoded `connected: false`, preventing misleading UI states during signup.
6. **Relational Pack Catalog Schema**:
   - `infra/db/migrations/015_packs.sql:12-45` — Defines `packs` catalog table and `org_packs` tenant junction table with `status CHECK (status IN ('installed', 'uninstalled', 'disabled'))`.
7. **Clean Uninstallation State Transition**:
   - `apps/dashboard/app/api/packs/route.ts:95-125` — `DELETE /api/packs` updates `org_packs.status = 'uninstalled'` and stamps `uninstalled_at = NOW()`, maintaining historical auditability.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Total Absence of Dashboard Frontend UI (`apps/dashboard/app/(dashboard)/packs/page.tsx` does not exist)**:
   - *User Impact*: High friction and zero visibility. Once an organization completes onboarding, administrators have no interface to see what packs are active, what tools or employees were granted by the pack, or how to enable additional industry verticals.
   - *Code Cause*: There is no page component or navigation link in `AppShell.tsx` for packs, making the feature invisible to paying customers.
2. **Hand-Duplicated Installation Logic Across Packages (`services/workflows/src/packs/install-pack.ts:12-160` vs `apps/dashboard/app/api/packs/_lib.ts:15-185`)**:
   - *User Impact*: Silent state desynchronization and configuration drift. Employees created during onboarding have different system prompts or tool sets than employees created via background workflows.
   - *Code Cause*: Employee definitions, system prompts, role descriptions, and tool allowlists are copy-pasted across two distinct packages without a single shared source of truth or shared module.
3. **Non-Transactional Pack Installation Cascade (`apps/dashboard/app/api/packs/_lib.ts:130-180`)**:
   - *User Impact*: Corrupted workspace state on network hiccup or DB error during signup.
   - *Code Cause*: `installPackForOrg` runs sequential queries across `ai_employees`, `org_connectors`, `org_memory`, and `org_packs` without wrapping the sequence in a `BEGIN ... COMMIT` block. If an error occurs midway, seeded employees remain in the database but `org_packs` has no record of the installation, causing retry attempts to crash or create duplicates.
4. **Onboarding Recommends Unshipped / Broken Packs (`apps/dashboard/app/(onboarding)/pack-recommendations.ts:50`)**:
   - *User Impact*: Onboarding failure and signup drop-off. Selecting "E-Commerce" during onboarding triggers an immediate HTTP 400 error.
   - *Code Cause*: The onboarding wizard recommends `packIds: [CORE_B2B, 'ecommerce']` for retail tenants. However, `'ecommerce'` is not in `LIVE_PACK_IDS` in `apps/dashboard/app/api/packs/route.ts:15-20`, causing the API to throw an unhandled error during workspace creation.
5. **Database Catalog Desynchronization (`apps/dashboard/app/api/packs/route.ts:12-30`)**:
   - *User Impact*: Discrepancies between API responses and database queries.
   - *Code Cause*: `GET /api/packs` queries `SELECT * FROM packs`, while `POST /api/packs` evaluates against a hardcoded TypeScript array `LIVE_PACK_IDS`. If migrations fail to populate `packs`, the UI displays an empty catalog even though the backend can install packs.
6. **Incomplete Pack Uninstallation Cleanup (`services/workflows/src/packs/install-pack.ts:153-168`)**:
   - *User Impact*: Ghost employees and clutter. Uninstalling a pack leaves all AI employees and memory documents active in the tenant's workspace.
   - *Code Cause*: `DELETE /api/packs` only marks `org_packs.status = 'uninstalled'`. Because `ai_employees` has no `pack_id` foreign key, the system cannot distinguish between custom user-created employees and pack-seeded employees to safely archive them.
7. **Silent Failure on Duplicate Employee Name Collisions (`apps/dashboard/app/api/packs/_lib.ts:20-25`)**:
   - *User Impact*: Missing AI capabilities. If a tenant creates an employee named "Maya" prior to installing a pack, the installer silently skips "Maya". The tenant never gets the specialized tools or prompt required for that vertical.
   - *Code Cause*: The deduplication logic `WHERE LOWER(name) = LOWER($1)` simply skips inserting without updating prompts or notifying the user of the conflict.
8. **Permanent Freezing of Pack Configurations (`org_packs.config`)**:
   - *User Impact*: Inability to customize vertical parameters (e.g. commission rates, showing duration, rental late fees).
   - *Code Cause*: `org_packs.config` defaults to `'{}'::jsonb`. There is no API route or UI modal allowing administrators to view or update these parameters.
9. **Missing Pack Upgrade Migrations**:
   - *User Impact*: Tenants are stuck on outdated agent prompts and missing new tools as the platform evolves.
   - *Code Cause*: Calling `installPackForOrg` on an already installed pack returns early without diffing or applying updates to system prompts or tool allowlists.
10. **Missing RBAC Role Verification on Pack Actions (`apps/dashboard/app/api/packs/route.ts:40-75`)**:
    - *User Impact*: Unauthorized members can install or uninstall enterprise packs.
    - *Code Cause*: Routes only verify session existence via `getScopedClient()`, without checking if the user is an `owner` or `admin`.
11. **Tool Allowlist Reference to Unregistered MCP Tools**:
    - *User Impact*: Runtime agent crashes when executing tools declared in pack manifests that do not exist in `mcp-bridge.ts`.
    - *Code Cause*: Pack manifests declare tool allowlists without compile-time or runtime schema validation against the master tool registry in `services/workflows/src/tool-executor.ts`.
12. **Race Condition on Concurrent Pack Installs**:
    - *User Impact*: Duplicate employee generation and primary pack conflicts.
    - *Code Cause*: If two administrators install packs simultaneously, the check-then-insert pattern causes unique constraint violations or duplicate child workflows.

---

## What's missing vs full vision

1. **Dedicated Packs Marketplace Page (`/packs`)**:
   - Visual catalog showcasing available vertical packs:
     - Real Estate Brokerage (Live)
     - Core B2B SaaS (Live)
     - E-Commerce Operations (Coming Soon)
     - Healthcare Practice (RFC)
     - Legal Practice (RFC)
   - Detailed modal showing bundled AI employees, system prompts, required tools, and connector prerequisites.
2. **Pack Employee Attribution Schema (`ai_employees.pack_id`)**:
   - Foreign key tracking which pack created each employee, allowing safe uninstallation, upgrade diffing, and scoped resets.
3. **Tenant Pack Configuration Drawer / Modal**:
   - Dedicated settings panel to tune vertical parameters:
     - Real Estate: Showing duration (30/60m), commission split (50/50), lockbox code policy.
     - Core B2B: Lead qualification thresholds, default meeting duration, trial period length.
4. **Automated Pack Upgrade Engine**:
   - Version tracking (`v1.0.0` → `v1.1.0`) with visual diff preview before updating employee prompts.
5. **Interactive Pack Dependency Visualizer**:
   - Architecture diagram illustrating how specialized industry packs extend the foundational Core B2B pack.
6. **Pre-Installation Connector Readiness Checklist**:
   - Diagnostic gate verifying whether required connectors (e.g. Google Calendar, WhatsApp) are authenticated before installing.
7. **Custom Enterprise Pack Builder**:
   - White-label feature allowing enterprise holding companies to package their proprietary agent SOPs and clone them across subsidiary tenants.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Schema Migration: Pack Enhancements & Employee Attribution (`032_packs_enhancements.sql`)
```sql
-- 1. Add pack attribution to ai_employees
ALTER TABLE ai_employees
  ADD COLUMN IF NOT EXISTS pack_id TEXT REFERENCES packs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_customized BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_ai_employees_pack ON ai_employees(org_id, pack_id);

-- 2. Add version and configuration schema to packs
ALTER TABLE packs
  ADD COLUMN IF NOT EXISTS version TEXT NOT NULL DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS config_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS is_live BOOLEAN NOT NULL DEFAULT false;

-- 3. Mark live packs in catalog
UPDATE packs SET is_live = true WHERE id IN ('core-b2b', 'real-estate-brokerage');

-- 4. Add upgrade tracking to org_packs
ALTER TABLE org_packs
  ADD COLUMN IF NOT EXISTS installed_version TEXT NOT NULL DEFAULT '1.0.0',
  ADD COLUMN IF NOT EXISTS last_upgraded_at TIMESTAMPTZ;
```

### 2. Consolidated Transactional Pack Installer (`packages/shared-packs/src/installer.ts`)
```typescript
import { PoolClient } from 'pg';
import { PackManifest, getPackManifest } from './manifests';

export async function installPackTransactional(
  client: PoolClient,
  orgId: string,
  packId: string,
  config: Record<string, any> = {},
  isPrimary: boolean = false
): Promise<{ success: boolean; installedEmployees: string[] }> {
  const manifest = getPackManifest(packId);
  if (!manifest) {
    throw new Error(`Pack ${packId} not found in catalog`);
  }

  // 1. Recursive installation of parent pack
  if (manifest.extends) {
    await installPackTransactional(client, orgId, manifest.extends, {}, false);
  }

  // 2. Check if already installed
  const existing = await client.query(
    'SELECT status FROM org_packs WHERE org_id = $1 AND pack_id = $2 FOR UPDATE',
    [orgId, packId]
  );

  if (existing.rowCount && existing.rows[0].status === 'installed') {
    return { success: true, installedEmployees: [] };
  }

  const installedEmployees: string[] = [];

  // 3. Seed AI Employees with pack attribution
  for (const emp of manifest.employees) {
    const res = await client.query(
      `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, status, pack_id)
       VALUES ($1, $2, $3, $4, $5, 'active', $6)
       ON CONFLICT (org_id, name) DO UPDATE SET
         tool_allowlist = array_cat(ai_employees.tool_allowlist, EXCLUDED.tool_allowlist),
         updated_at = NOW()
       RETURNING id, name`,
      [orgId, emp.name, emp.role, emp.persona, emp.toolAllowlist, packId]
    );
    installedEmployees.push(res.rows[0].name);
  }

  // 4. Seed Recommended Connectors
  for (const provider of manifest.recommendedConnectors) {
    await client.query(
      `INSERT INTO org_connectors (org_id, provider, status)
       VALUES ($1, $2, 'disconnected')
       ON CONFLICT (org_id, provider) DO NOTHING`,
      [orgId, provider]
    );
  }

  // 5. Seed Memory SOPs
  for (const sop of manifest.memorySops) {
    await client.query(
      `INSERT INTO org_memory (org_id, title, body, tier, source)
       VALUES ($1, $2, $3, 'org_memory', $4)
       ON CONFLICT (org_id, title) DO UPDATE SET
         body = EXCLUDED.body,
         updated_at = NOW()`,
      [orgId, sop.title, sop.body, `pack:${packId}`]
    );
  }

  // 6. Record in org_packs
  await client.query(
    `INSERT INTO org_packs (org_id, pack_id, status, config, is_primary, installed_version, installed_at)
     VALUES ($1, $2, 'installed', $3, $4, $5, NOW())
     ON CONFLICT (org_id, pack_id) DO UPDATE SET
       status = 'installed',
       config = EXCLUDED.config,
       uninstalled_at = NULL,
       updated_at = NOW()`,
    [orgId, packId, JSON.stringify(config), isPrimary, manifest.version || '1.0.0']
  );

  return { success: true, installedEmployees };
}
```

### 3. Pack Configuration Mutation Route (`apps/dashboard/app/api/packs/[id]/config/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole } from '@/lib/auth-helpers';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json({ error: 'Admin permission required' }, { status: 403 });
    }

    const { config } = await req.json();
    if (!config || typeof config !== 'object') {
      return NextResponse.json({ error: 'Invalid config payload' }, { status: 400 });
    }

    const res = await client.query(
      `UPDATE org_packs
       SET config = config || $1::jsonb,
           updated_at = NOW()
       WHERE org_id = $2 AND pack_id = $3 AND status = 'installed'
       RETURNING pack_id, config`,
      [JSON.stringify(config), orgId, params.id]
    );

    if (res.rowCount === 0) {
      return NextResponse.json({ error: 'Pack not installed' }, { status: 404 });
    }

    return NextResponse.json({ success: true, pack: res.rows[0] });
  } finally {
    client.release();
  }
}
```

### 4. Packs Dashboard Marketplace UI (`apps/dashboard/app/(dashboard)/packs/page.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import { Package, CheckCircle2, AlertCircle, ArrowUpRight, Settings, Sparkles } from 'lucide-react';

interface PackItem {
  id: string;
  name: string;
  description: string;
  version: string;
  isLive: boolean;
  status: 'installed' | 'uninstalled' | 'available';
  employees: Array<{ name: string; role: string }>;
  connectors: string[];
}

export default function PacksMarketplacePage() {
  const [packs, setPacks] = useState<PackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/packs')
      .then((res) => res.json())
      .then((data) => {
        setPacks(data.packs || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleInstall = async (packId: string) => {
    setInstalling(packId);
    try {
      const res = await fetch('/api/packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId })
      });
      if (res.ok) {
        window.location.reload();
      }
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Package className="w-6 h-6 text-emerald-400" />
            Industry Starter Packs
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Pre-configured bundles of AI employees, domain SOPs, and tool allowlists tailored to your vertical.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {packs.map((pack) => {
          const isInstalled = pack.status === 'installed';
          return (
            <div
              key={pack.id}
              className={`p-6 rounded-xl border transition ${
                isInstalled
                  ? 'bg-slate-900/80 border-emerald-500/30'
                  : 'bg-slate-900/40 border-slate-800 hover:border-slate-700'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-semibold text-slate-200">{pack.name}</h3>
                    {isInstalled ? (
                      <span className="flex items-center gap-1 text-xs font-medium text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                        <CheckCircle2 className="w-3 h-3" /> Installed
                      </span>
                    ) : pack.isLive ? (
                      <span className="text-xs font-medium text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">
                        Ready
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">
                        RFC / Coming Soon
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-400 mt-2">{pack.description}</p>
                </div>
              </div>

              <div className="mt-6 border-t border-slate-800/80 pt-4">
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                  Bundled Employees
                </div>
                <div className="flex flex-wrap gap-2">
                  {pack.employees.map((emp) => (
                    <span
                      key={emp.name}
                      className="text-xs bg-slate-800 text-slate-300 px-2.5 py-1 rounded-md border border-slate-700/60"
                    >
                      {emp.name} ({emp.role})
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-6 flex items-center justify-between pt-4 border-t border-slate-800/80">
                <span className="text-xs text-slate-500">Version {pack.version}</span>
                {isInstalled ? (
                  <button
                    onClick={() => alert('Open configuration modal')}
                    className="flex items-center gap-1.5 text-xs font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg border border-slate-700 transition"
                  >
                    <Settings className="w-3.5 h-3.5" /> Configure
                  </button>
                ) : (
                  <button
                    disabled={!pack.isLive || installing === pack.id}
                    onClick={() => handleInstall(pack.id)}
                    className="flex items-center gap-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-1.5 rounded-lg transition"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {installing === pack.id ? 'Installing...' : 'Install Pack'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

---

## Fix priority

- **P0**: Fix onboarding crash where recommending `'ecommerce'` triggers a 400 error during tenant creation.
- **P0**: Unify duplicated install logic between `@darex/workflows` and Next.js API into a single shared installer module.
- **P0**: Wrap all pack installations in an atomic PostgreSQL transaction (`BEGIN ... COMMIT`) to prevent corrupted partial state.
- **P1**: Build dedicated `/packs` dashboard UI so customers can explore, inspect, and install industry packs post-onboarding.
- **P1**: Add RBAC authorization checks to `/api/packs` ensuring only workspace owners and admins can trigger installations.
- **P2**: Deploy `ai_employees.pack_id` attribution column to support clean uninstallation and updates.
- **P2**: Implement pack configuration editor in the UI to populate and validate `org_packs.config`.
- **P2**: Add pre-installation readiness checker highlighting unauthenticated connectors before pack activation.
