# Org & Multi-Tenancy Audit

## Status: 🟢 core tenancy closed (pool RLS wrap, transactional create, orgs RLS, memberships, kill-switch/rollout RBAC, session rebind, suspended-org gate, single-org resolvers neutralized)

The multi-tenancy architecture (`apps/dashboard/lib/db.ts`, `infra/db/migrations/*`, and `apps/dashboard/app/api/org/*`) enforces strict tenant isolation at the data tier. It resolves `org_id` exclusively from cryptographically verified session cookies, sets `app.current_org_id` at the PostgreSQL session level with automatic `RESET` on client release, enforces PostgreSQL Row-Level Security (`FORCE ROW LEVEL SECURITY`) across tenant operational tables including `orgs`, rejects body/query `org_id`, gates suspended/soft_deleted workspaces in `getScopedClient()` (HTTP 402; billing may pass `allowSuspended`), and never falls back to “the only active org” for inbound webhooks.

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Strict Session-Derived Tenant Resolution (Anti-Spoofing Defense)**:
   - `apps/dashboard/lib/db.ts:42-72` — `getScopedClient()`:
     - Extracts and cryptographically validates the session cookie via `parseSessionCookie()`.
     - Queries the authenticated user's `org_id` from PostgreSQL:
       ```typescript
       const userRes = await pool.query('SELECT org_id FROM users WHERE id = $1', [userId]);
       const orgId = userRes.rows[0]?.org_id;
       ```
     - Executes `SELECT set_config('app.current_org_id', $1, false)` to configure session-level GUC variables on the checked-out pool connection.
     - Rejects any client-supplied `orgId` or `org_id` in request bodies or query parameters across all mutating endpoints in `app/api/org/*` (`create`, `kill-switch`, `rollout`), returning HTTP 400 (`org/create/route.ts:77-82`).
2. **PostgreSQL Connection Pool Protection via Automatic GUC Resets**:
   - `apps/dashboard/lib/db.ts:94-128`:
     - Monkey-patches `client.release` to execute `RESET app.current_org_id` and `RESET app.current_user_id` before returning connections to the shared pool.
     - On any query error, the client is explicitly destroyed (`pool.destroy(client)`) rather than recycled back into the pool, guaranteeing that no subsequent request can inherit a contaminated tenant context or leftover GUC state.
3. **Database-Level Row-Level Security (RLS) Enforcement Across Operational Tables**:
   - Explicitly configured across `conversations`, `messages`, `work_items`, `agent_plans`, `ai_employees`, `channels`, `org_memory`, `re_listings`, `re_inquiries`, `re_showings`, and `agent_decision_ledger`.
   - Migrations (`infra/db/migrations/001_init.sql`, `010_real_estate.sql`, `020_org_memory.sql`, `022_realtime_stream.sql`) run:
     ```sql
     ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
     ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
     CREATE POLICY conversations_org_isolation ON conversations
       FOR ALL USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
     ```
   - `FORCE ROW LEVEL SECURITY` prevents table owners (e.g. `darex_app`) from accidentally bypassing RLS policies during routine operational queries.
4. **Data Subject Rights (DSR) Tenant Scoping**:
   - `apps/dashboard/app/api/dsr/delete/route.ts:42-95`:
     - GDPR/CCPA data erasure requests strictly verify that the target customer or conversation belongs to the requesting session's `org_id` prior to executing cascading deletions.
5. **Autonomy Kill-Switch State Persistence**:
   - `apps/dashboard/app/api/org/kill-switch/route.ts:35-80`:
     - Toggles autonomous execution state globally for an organization by persisting `autonomy_enabled: false` into `orgs.settings` JSONB or disabling active rules in `autonomy_rules`.
6. **Canary Rollout Configuration**:
   - `apps/dashboard/app/api/org/rollout/route.ts:28-65`:
     - Supports staged progressive rollout of agent models and runtime capabilities across a percentage of incoming traffic by storing rollout flags in `orgs.rollout_flags`.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Missing Row-Level Security on the Root `orgs` Table (`infra/db/migrations/001_init.sql:10-25`)**:
   - *User Impact*: High-risk tenant data exposure. If any internal endpoint or background report executes a join or query against `orgs` without an explicit `WHERE id = $1`, PostgreSQL returns all organizations in the cluster.
   - *Code Cause*: While peripheral operational tables have `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, `orgs` was left un-scoped in migration `001_init.sql`. The table requires an isolation policy: `FOR ALL USING (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)`.
2. **Non-Transactional Organization Provisioning Cascade (`apps/dashboard/app/api/org/create/route.ts:85-180`)**:
   - *User Impact*: Corrupted "zombie" organizations. New users can become trapped in a broken workspace where the organization exists but has no employees, no industry pack, and missing autonomy rules.
   - *Code Cause*: `POST /api/org/create` orchestrates 6 sequential steps (insert `orgs`, update `users.org_id`, `seedDefaultEmployees`, `seedDefaultAutonomyRules`, `installPackForOrg`, `kickPeriodicSweeps`) across multiple separate DB queries **without an enclosing `BEGIN ... COMMIT` block**. If pack installation or employee seeding throws an error (e.g. unreleased pack slug or network glitch), the partial state remains committed in Postgres with no rollback.
3. **Unprotected Kill-Switch & Rollout Endpoints (Missing Human RBAC) (`apps/dashboard/app/api/org/kill-switch/route.ts:22-45`, `apps/dashboard/app/api/org/rollout/route.ts:18-40`)**:
   - *User Impact*: Hostile or accidental shutdown of entire AI employee fleet by unauthorized users.
   - *Code Cause*: Both routes call `getScopedClient()` which verifies session authenticity, but **neither endpoint verifies the user's role** via `loadHumanRole()`. Any member with a basic `member` or `auditor` session can invoke `POST /api/org/kill-switch` with `{ active: true }` and instantly kill all customer-facing agents.
4. **Single-Organization User Ceiling (No Multi-Org Tenancy) (`infra/db/migrations/001_init.sql:30-45`)**:
   - *User Impact*: Property managers, real estate agencies, and franchise operators managing multiple portfolios cannot switch workspaces using a single account; they must register separate email addresses for each client.
   - *Code Cause*: The database schema ties users to an organization via a single column: `users.org_id UUID REFERENCES orgs(id)`. There is no `organization_memberships` junction table, preventing many-to-many user-to-organization relationships.
5. **Direct Cross-Tenant Webhook Leakage via Single-Org Fallbacks (`apps/dashboard/app/api/webhooks/whatsapp/route.ts:55-75`)**:
   - *User Impact*: Inbound WhatsApp messages from foreign prospective clients leak into the first organization created on the platform.
   - *Code Cause*: Fallback functions (`lookupSingleOrgWhatsApp`, `resolveSingleOrgChannel`) query `SELECT id FROM orgs ORDER BY created_at ASC LIMIT 1` when inbound phone numbers cannot be mapped to a registered channel, erroneously dumping unmapped traffic into the earliest tenant.
6. **No Organization Suspension State on Prolonged Payment Failure (`apps/dashboard/lib/db.ts:42-72`)**:
   - *User Impact*: Financial loss from uncollected compute expenses. Delinquent accounts continue consuming expensive LLM tokens and external tool APIs indefinitely.
   - *Code Cause*: `getScopedClient()` checks if `orgId` exists but never checks `orgs.status`. If `status === 'suspended'` or `status === 'delinquent'`, requests are allowed to proceed without restriction instead of returning HTTP 402 Payment Required.
7. **Race Condition in Organization Slug Resolution (`apps/dashboard/app/api/org/create/route.ts:50-70`)**:
   - *User Impact*: 500 Internal Server Error when two organizations register simultaneously with similar company names.
   - *Code Cause*: The slug generator does a pre-flight `SELECT id FROM orgs WHERE slug = $1`, computes a counter suffix, and inserts later without database locking. Concurrent registrations with identical names collide on the `orgs_slug_key` unique constraint.
8. **Superuser Connection Pool Bypass Risk (`infra/db/init/01-init.sh`)**:
   - *User Impact*: Complete nullification of RLS if environment variables are misconfigured.
   - *Code Cause*: In PostgreSQL, the table owner or superuser (`postgres`, `darex`) bypasses RLS unless `FORCE ROW LEVEL SECURITY` is explicitly set on every single table. If `DB_USER` defaults to `darex` instead of `darex_app` in production containers, all tenant isolation policies are silently ignored.
9. **Incomplete Workspace Teardown / Orphaned Cloud Resources**:
   - *User Impact*: Zombie background workflows executing against deleted workspaces, driving up API bills and spamming external webhooks.
   - *Code Cause*: When an organization is deleted or marked inactive, there is no cascading cleanup saga to cancel running Temporal workflows (`TemporalClient.workflow.getHandle(id).cancel()`), disconnect Nango OAuth connections, or wipe vector embeddings in `org_memory`.
10. **Lack of Tenant-Level Rate Limiting and Token Quotas (`apps/dashboard/middleware.ts`)**:
    - *User Impact*: "Noisy Neighbor" syndrome where a single tenant's massive batch job exhausts database pool connections and LiteLLM rate limits for all tenants.
    - *Code Cause*: Rate limiting is not enforced per-tenant at the edge middleware. Requests are processed on a first-come, first-served basis across shared resources.
11. **Custom Domain Routing Missing Automated TLS Provisioning**:
    - *User Impact*: Enterprise tenants cannot white-label their dashboard or embed the chat widget on their custom domain.
    - *Code Cause*: No domain verification schema (`org_domains`), CNAME validation workflow, or automated SSL certificate provisioning via Let's Encrypt / Cloudflare for SaaS.
12. **Vector Embedding Cross-Tenant Leakage Risk (`apps/dashboard/lib/brain.ts:85-120`)**:
    - *User Impact*: AI employees citing private internal documents belonging to another organization during RAG searches.
    - *Code Cause*: If a developer writes a raw vector similarity search using `pgvector` operators (`<=>`) without an explicit `WHERE org_id = current_setting('app.current_org_id', true)::uuid` clause, index scans can return nearest-neighbor chunks from other tenants.

---

## What's missing vs full vision

1. **Multi-Org Membership Junction Architecture**:
   - Full migration to `organization_memberships (user_id, org_id, role, created_at)` allowing users to switch between workspaces effortlessly without logging out.
2. **Workspace Switcher UI Component**:
   - Sleek dropdown in the dashboard sidebar displaying all active organizations for the user, current active workspace badge, and an "Add New Workspace" modal.
3. **Tenant Data Residency & Region Pinning**:
   - Dedicated database cluster routing (`us-east-1`, `eu-central-1`) for enterprise tenants requiring strict geographic data sovereignty compliance.
4. **Tenant Lifecycle State Machine (`active`, `trialing`, `past_due`, `suspended`, `soft_deleted`, `purged`)**:
   - Automated state transitions with read-only dashboard access for suspended accounts and 30-day grace periods before data purging.
5. **Self-Service Tenant Data Export (GDPR Takeout)**:
   - One-click asynchronous export generating a secure pre-signed S3/R2 download URL containing all customer conversations, listings, documents, and audit logs.
6. **Tenant-Level BYOK (Bring Your Own Key)**:
   - Vault-encrypted per-tenant API keys for LiteLLM, OpenAI, and Anthropic allowing enterprise customers to consume their own cloud credits.
7. **White-Labeled Custom Domains**:
   - Tenant domain management UI supporting custom CNAME records (e.g. `concierge.luxuryrealty.com`) with automated SSL validation.
8. **Hierarchical Organization Units**:
   - Parent/Child organizational structures for franchise brokerages and enterprise holding companies with centralized billing and sub-tenant autonomy controls.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Multi-Org Memberships & Root RLS (`029_org_tenancy_hardening.sql`)
```sql
-- 1. Enable RLS on root orgs table
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;

CREATE POLICY orgs_tenant_isolation ON orgs
  FOR ALL USING (id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- 2. Create organization_memberships table
CREATE TABLE organization_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'auditor')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, org_id)
);

CREATE INDEX idx_org_memberships_user ON organization_memberships(user_id);
CREATE INDEX idx_org_memberships_org ON organization_memberships(org_id);

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY org_memberships_isolation ON organization_memberships
  FOR ALL USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR user_id = NULLIF(current_setting('app.current_user_id', true), '')
  );

-- 3. Backfill existing single-org users into organization_memberships
INSERT INTO organization_memberships (user_id, org_id, role, is_default)
SELECT id, org_id, COALESCE(role, 'member'), true
FROM users
WHERE org_id IS NOT NULL
ON CONFLICT (user_id, org_id) DO NOTHING;

-- 4. Add tenant lifecycle status and custom domain fields to orgs
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trialing', 'past_due', 'suspended', 'soft_deleted')),
  ADD COLUMN IF NOT EXISTS custom_domain TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS domain_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;
```

### 2. Transactional Organization Provisioning Route (`apps/dashboard/app/api/org/create/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '@/lib/db';
import { parseSessionCookie } from '@/lib/session-cookie';
import { seedDefaultEmployees } from '@/lib/seed-employees';
import { seedDefaultAutonomyRules } from '@/lib/seed-autonomy';
import { installPackForOrg } from '@/lib/packs';
import { TemporalClient } from '@/lib/temporal-client';

export async function POST(req: NextRequest) {
  const session = await parseSessionCookie(req);
  if (!session?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  if (body.orgId || body.org_id) {
    return NextResponse.json({ error: 'Specifying orgId is forbidden' }, { status: 400 });
  }

  const { name, industryPack = 'real_estate' } = body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'Organization name is required' }, { status: 400 });
  }

  const pool = getDbPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Generate unique slug with transaction-safe locking
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    let slug = baseSlug;
    let counter = 1;
    while (true) {
      const existing = await client.query('SELECT id FROM orgs WHERE slug = $1 FOR UPDATE', [slug]);
      if (existing.rowCount === 0) break;
      slug = `${baseSlug}-${counter++}`;
    }

    // 2. Insert organization
    const orgRes = await client.query(
      `INSERT INTO orgs (name, slug, status)
       VALUES ($1, $2, 'active')
       RETURNING id, name, slug`,
      [name.trim(), slug]
    );
    const newOrgId = orgRes.rows[0].id;

    // 3. Set session context for RLS in this transaction
    await client.query(`SELECT set_config('app.current_org_id', $1, true)`, [newOrgId]);
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [session.userId]);

    // 4. Create Owner Membership
    await client.query(
      `INSERT INTO organization_memberships (user_id, org_id, role, is_default)
       VALUES ($1, $2, 'owner', true)`,
      [session.userId, newOrgId]
    );

    // 5. Update user's active org_id pointer
    await client.query('UPDATE users SET org_id = $1 WHERE id = $2', [newOrgId, session.userId]);

    // 6. Seed employees and autonomy rules within transaction
    await seedDefaultEmployees(client, newOrgId);
    await seedDefaultAutonomyRules(client, newOrgId);

    // 7. Install industry pack within transaction
    await installPackForOrg(client, newOrgId, industryPack);

    await client.query('COMMIT');

    // 8. Start background sweeps after commit succeeds
    TemporalClient.startPeriodicSweeps(newOrgId).catch((err) => {
      console.error(`[OrgCreate] Failed to schedule background sweeps for ${newOrgId}:`, err);
    });

    return NextResponse.json({
      success: true,
      org: { id: newOrgId, name: orgRes.rows[0].name, slug: orgRes.rows[0].slug }
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('[OrgCreate] Transaction failed and rolled back:', err);
    return NextResponse.json({ error: err.message || 'Failed to create organization' }, { status: 500 });
  } finally {
    client.release();
  }
}
```

### 3. RBAC Enforcement on Kill-Switch (`apps/dashboard/app/api/org/kill-switch/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole } from '@/lib/auth-helpers';

export async function POST(req: NextRequest) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden: Only owners and admins can toggle the AI employee kill-switch' },
        { status: 403 }
      );
    }

    const { active } = await req.json();
    await client.query(
      `UPDATE orgs
       SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{autonomy_enabled}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(!active), orgId]
    );

    // Log security audit event
    await client.query(
      `INSERT INTO audit_events (org_id, user_id, event_type, payload)
       VALUES ($1, $2, 'kill_switch_toggled', $3)`,
      [orgId, userId, JSON.stringify({ killSwitchActive: active, triggeredBy: userId })]
    );

    return NextResponse.json({ success: true, killSwitchActive: active });
  } finally {
    client.release();
  }
}
```

### 4. Organization Switcher API Endpoint (`apps/dashboard/app/api/org/switch/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '@/lib/db';
import { parseSessionCookie, applySessionCookies } from '@/lib/session-cookie';

export async function POST(req: NextRequest) {
  const session = await parseSessionCookie(req);
  if (!session?.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { targetOrgId } = await req.json();
  if (!targetOrgId) {
    return NextResponse.json({ error: 'targetOrgId is required' }, { status: 400 });
  }

  const pool = getDbPool();
  const membership = await pool.query(
    `SELECT om.role, o.status, o.name
     FROM organization_memberships om
     JOIN orgs o ON o.id = om.org_id
     WHERE om.user_id = $1 AND om.org_id = $2`,
    [session.userId, targetOrgId]
  );

  if (membership.rowCount === 0) {
    return NextResponse.json({ error: 'Forbidden: You are not a member of this workspace' }, { status: 403 });
  }

  if (membership.rows[0].status === 'suspended') {
    return NextResponse.json({ error: 'Workspace is suspended due to billing issues' }, { status: 402 });
  }

  // Update active org pointer
  await pool.query('UPDATE users SET org_id = $1 WHERE id = $2', [targetOrgId, session.userId]);

  const res = NextResponse.json({
    success: true,
    activeOrg: { id: targetOrgId, name: membership.rows[0].name, role: membership.rows[0].role }
  });

  return res;
}
```

### 5. Frontend Organization Switcher Component (`components/OrganizationSwitcher.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, ChevronDown, Check, Plus } from 'lucide-react';

interface Workspace {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
}

export function OrganizationSwitcher() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    fetch('/api/org/memberships')
      .then((res) => res.json())
      .then((data) => setWorkspaces(data.memberships || []))
      .catch(console.error);
  }, []);

  const activeWorkspace = workspaces.find((w) => w.isActive) || workspaces[0];

  const handleSwitch = async (targetOrgId: string) => {
    setIsOpen(false);
    const res = await fetch('/api/org/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetOrgId })
    });
    if (res.ok) {
      router.refresh();
      window.location.reload();
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full px-3 py-2 text-sm font-medium text-slate-200 bg-slate-800/80 hover:bg-slate-700/80 rounded-lg border border-slate-700 transition"
      >
        <div className="flex items-center gap-2 truncate">
          <Building2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span className="truncate">{activeWorkspace?.name || 'Select Workspace'}</span>
        </div>
        <ChevronDown className="w-4 h-4 text-slate-400 shrink-0 ml-2" />
      </button>

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-slate-900 border border-slate-800 rounded-lg shadow-xl z-50 py-1">
          <div className="px-3 py-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Workspaces
          </div>
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => handleSwitch(ws.id)}
              className="flex items-center justify-between w-full px-3 py-2 text-sm text-left hover:bg-slate-800 transition"
            >
              <div className="truncate">
                <div className="text-slate-200 font-medium truncate">{ws.name}</div>
                <div className="text-xs text-slate-400 capitalize">{ws.role}</div>
              </div>
              {ws.isActive && <Check className="w-4 h-4 text-emerald-400 shrink-0" />}
            </button>
          ))}
          <div className="border-t border-slate-800 mt-1 pt-1">
            <button
              onClick={() => router.push('/onboarding?mode=new_workspace')}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-emerald-400 hover:bg-slate-800 transition font-medium"
            >
              <Plus className="w-4 h-4" />
              <span>Create Workspace</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## Fix priority

- **P0**: Wrap organization creation (`POST /api/org/create`) in an atomic database transaction (`BEGIN ... COMMIT`) to prevent orphaned zombie workspaces on partial failures. ✅ done
- **P0**: Add RBAC role checks to `/api/org/kill-switch` and `/api/org/rollout` to prevent unprivileged members from disabling autonomous agents. ✅ done (owner/admin via `canManageOrgSettings`)
- **P1**: Enable Row-Level Security on the root `orgs` table (`097_org_tenancy_auth_hardening.sql`) to prevent accidental cross-tenant data leaks. ✅ done
- **P1**: Remove single-org fallback queries (`SELECT id FROM orgs LIMIT 1`) in inbound webhooks to prevent message misrouting. ✅ done (TS `resolveSingleOrgChannel` → null; migration `106` empties SECURITY DEFINER helpers)
- **P1**: Implement tenant suspension check in `getScopedClient()` to reject mutating requests for delinquent accounts. ✅ done (`OrgSuspendedError` → 402; billing uses `allowSuspended`)
- **P2**: Deploy `organization_memberships` table and sidebar workspace switcher for multi-workspace management. 🟡 Partial (API, memberships and shell switcher incl. create Done)
- **P2**: Build asynchronous tenant deletion saga to gracefully cancel Temporal workflows, disconnect Nango tokens, and purge vector embeddings. 🔴 Blocked (needs product design for soft-delete grace + Temporal cancel orchestration)
- **P2**: Add per-tenant rate limiting and token consumption quotas to prevent noisy-neighbor database saturation. 🔴 Blocked (owned with auth/billing usage-gate; not a pure tenancy schema fix)

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Direct `pool.connect()` bypasses RLS GUC reset on release | P0 | `apps/dashboard/lib/db.ts` | 🟢 Done | `installPoolConnectGuard` wraps every checkout; release `RESET app.current_org_id` then `RESET app.current_user_id`; `_darexScoped` keeps getScopedClient safe |
| 2 | Kill-switch / rollout lack human RBAC | P0 | `app/api/org/kill-switch`, `rollout` | 🟢 Done | Mutations require `canManageOrgSettings` |
| 3 | Org switch must rebind session cookies | P0 | `app/api/org/switch` | 🟢 Done | Membership verified; `users.org_id` updated; `applySessionCookies` rotates session+org cookies |
| 4 | Non-transactional org create | P0 | `app/api/org/create` | 🟢 Done | BEGIN/COMMIT around orgs name + channels + org_onboarding; seed after commit |
| 5 | Missing RLS on root `orgs` table | P1 | `097_org_tenancy_auth_hardening.sql` | 🟢 Done | FORCE RLS; SELECT/UPDATE/DELETE scoped; INSERT only via `auth_create_org()` (row 10) |
| 6 | Multi-org memberships | P2 | migration + `/api/org/memberships` + switch | 🟢 Done | `organization_memberships` backfilled; list + switch wired |
| 7 | Suspended org still gets a full session | P1 | `apps/dashboard/lib/db.ts` `getScopedClient` | 🟢 Done | `assertOrgSessionAllowed`; soft_deleted always blocked; suspended → 402 via `scopedAuthErrorResponse`; billing `allowSuspended: true`. Unit: `org-session-status.test.ts`. Live DB not applied this session (migration not run on shared DB). |
| 8 | Single-org webhook SQL fallbacks | P1 | `010` helpers / `channel-normalize.ts` | 🟢 Done | TS already returned null; `108_neutralize_single_org_resolvers.sql` makes SECURITY DEFINER helpers always empty. Migration not applied to shared DB this session. |
| 9 | `darex_platform` had no grants; 119 platform arms broke tenant reads (SEC-P01) | P0 | `200_platform_role_grants.sql` | 🟢 Done | Role-scoped `<table>_platform` policies; tenant policies back to plain org_id. Live PG17: isolation suite passes as darex_app and darex_platform |
| 10 | Tenant-writable globals: `platform_send_counters`, `pack_entity_schemas`, `rera_cache`, `predicate_defs`, `orgs` INSERT (SEC-T01/T02/T05) | P1 | `201_global_table_boundaries.sql` | 🟢 Done | Direct writes revoked; SECURITY DEFINER `platform_send_counter_bump` / `rera_cache_put` / `auth_create_org`. Live PG17: every direct write → 42501 |
| 9 | Superuser pool bypass if `DB_USER=darex` | P1 | `lib/boot-guards.ts` | 🟢 Done | Production refuse-boot when `DB_USER` missing or is `darex`/`postgres` |
| 10 | Vector search missing org filter | P1 | brain + `memory/retrieve.ts` | 🟢 Done | Hybrid retrieval already binds `WHERE … org_id = $1` (+ RLS); no ungeated `<=>` path found |
| 11 | Workspace switcher UI | P2 | dashboard shell | 🟢 Done | `OrganizationSwitcher` in `AppShell` lists memberships and switches; "New workspace" calls `POST /api/org/workspaces` (owner, max 10 per user, then onboarding). Not live-verified. |
| 12 | Tenant deletion / offboarding saga | P2 | Temporal + Nango + memory | 🔴 Blocked | Needs product lifecycle design (grace, purge, cancel workflows) |
| 13 | Per-tenant rate / token quotas at edge | P2 | middleware / usage-gate | 🔴 Blocked | Cross-domain with billing usage-gate; not closed in this tenancy pass |
| 14 | Custom domains + automated TLS | P2 | infra | 🔴 Blocked | Human/infra (DNS + cert automation); no schema work this pass |
