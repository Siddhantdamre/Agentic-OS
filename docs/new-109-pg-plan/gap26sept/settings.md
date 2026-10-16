# Settings Audit

## Status: 🟢 settings mutations closed (RBAC, seats, members, autonomy PATCH, invite rate limit)

**Read gate:** 🟢 `GET` on `/api/settings/pending`, `/autonomy` and `/suppressions` now 403s for the `billing` role (`canReadOperations`: owner, admin, member, auditor may read). Jest covers the role matrix; not exercised live.

The Settings subsystem (`apps/dashboard/app/(dashboard)/settings/*` and `/api/settings/*`) covers organization profile management, team invitations, widget embed keys, learned suppression rules (`/api/settings/suppressions`), and autonomy tiers (`/api/settings/autonomy`). It strictly enforces session-scoped multi-tenancy, rejects body `org_id` overrides, hashes invite tokens with SHA-256, and dispatches transactional emails via Resend.

However, **administrators have no way to remove team members or change user roles** (leaving departed employees with permanent access), autonomy rules and pending actions are strictly read-only in the settings UI, there is no organization teardown / account deletion endpoint, and invite dispatches lack rate limiting.

---

## What works (cite file:line)

1. **Multi-Tenant Organization Configuration Retrieval**:
   - `apps/dashboard/app/api/settings/route.ts:40-92` — `GET /api/settings`:
     - Retrieves organization details, team roster (`users`), and active invites (`org_invites`) scoped strictly to `orgId` via `getScopedClient()`.
2. **Multi-Action Dispatcher**:
   - `apps/dashboard/app/api/settings/route.ts:94-220` — `POST /api/settings`:
     - `update_org`: Updates organization name (`route.ts:114-120`).
     - `invite_member`: Inserts into `org_invites` with SHA-256 hashed token (`sha256Hex`, line 147) and dispatches real transactional invite emails via `sendTransactionalEmail` (`route.ts:169`).
     - `rotate_widget_key`: Revokes old embed tokens and generates a new hashed key (`lib/widget-embed.ts:96-136`).
     - `update_widget_origins`: Updates allowed CORS domains in `channels.meta`.
3. **Strict Anti-Spoofing Guard**:
   - `route.ts:106-111` and `suppressions/route.ts:79-81`:
     - Rejects client requests attempting to supply `orgId` or `org_id` with explicit HTTP 400 errors (`"Client cannot specify tenant identity"`).
4. **Session-Level PostgreSQL RLS Enforcement**:
   - `apps/dashboard/lib/db.ts:42-72`:
     - Sets `app.current_org_id` at the database session level, and automatically resets it on client release (`RESET app.current_org_id`), eliminating connection pool tenant bleed.
5. **Learned Suppression Rules Management**:
   - `apps/dashboard/app/api/settings/suppressions/route.ts:15-115`:
     - Allows managers to view and delete preference suppressions (`agent_preference_suppressions`) to unblock previously suppressed agent behaviors.
6. **Autonomy Tier Fetcher**:
   - `apps/dashboard/app/api/settings/autonomy/route.ts:9-40`:
     - Queries `employee_autonomy_rules` to display the active governance tier for each AI employee persona.
7. **Connection Pool Safety Across Routes**:
   - `apps/dashboard/app/api/settings/route.ts:88, 218` and `suppressions/route.ts:60, 110`:
     - Client connections are released unconditionally in `finally` blocks, preventing connection pool exhaustion.
8. **Token Hashing with SHA-256 for Invitations**:
   - `apps/dashboard/app/api/settings/route.ts:147`:
     - Raw invitation tokens are never stored plaintext in Postgres; only `sha256Hex(rawToken)` is persisted.

---

## What's broken (code-level bugs, edge cases, failure modes)

1. **Total Inability to Remove Team Members or Modify Roles (P0)**:
   - While `POST /api/settings` provides an `invite_member` action, **there is no endpoint to remove an existing user (`DELETE /api/settings/members/[id]`) or change their role (`PATCH /api/settings/members/[id]`)**.
   - If an employee is terminated or leaves the company, an administrator cannot revoke their access from the dashboard. The ex-employee retains full dashboard access until an engineer manually runs raw SQL deletes in Postgres.
2. **Read-Only Autonomy Rules (Cosmetic Settings UI) (P1) (`api/settings/autonomy/route.ts:9-40`)**:
   - `/api/settings/autonomy` only exports a `GET` handler.
   - The settings UI displays employee autonomy tiers (`Notice`, `Draft`, `Act Internally`, `Act Externally`), but **provides zero edit buttons or mutation endpoints**. Administrators cannot change an employee's autonomy level or adjust confidence thresholds from the settings screen.
3. **Duplicate, Read-Only Pending Actions Route (`api/settings/pending/route.ts:10-50`)**:
   - The settings route lists pending actions (`GET`), but implements no action handlers. Users viewing pending items in Settings are unable to approve or reject them, requiring navigation to `/observability`.
4. **Unthrottled Team Invite Email Floods (P1)**:
   - The `invite_member` action lacks rate limiting.
   - An authenticated user can spam the endpoint in an automated loop, sending thousands of invite emails to external addresses via Resend, exhausting company email quotas and triggering spam blacklists.
5. **Missing Organization Deletion & Account Teardown Route (P1)**:
   - There is no `DELETE /api/settings/org` endpoint.
   - A customer who cancels their subscription cannot delete their workspace, scrub their database records, or revoke stored connector tokens, creating a GDPR "Right to be Forgotten" compliance failure.
6. **Concurrent Invite Acceptance Race Condition**:
   - Two users clicking an invitation link simultaneously can trigger parallel insert attempts, resulting in duplicate user accounts or primary key constraint violations if the token claim is non-atomic.
7. **No Invalidation of Active Sessions on Role Demotion**:
   - Even if a user's role is updated in the database, their active cookie session continues to carry their previous privileges until cookie expiration, because session verification checks the signed cookie without re-querying the database role on every request.
8. **Missing Audit Log of Settings Changes**:
   - When an admin renames an organization, rotates widget keys, or invites a user, **no record is written to `audit_events`**. There is no audit trail showing who modified security-critical workspace parameters.
9. **Unvalidated Allowed Origins Input**:
   - The CORS allowed origins field accepts raw strings without validating valid domain or URL formats, risking invalid header injections or broken CORS responses for client widgets.
10. **Inability to Transfer Workspace Ownership**:
    - There is no mechanism for an organization creator to transfer the `owner` role to another administrator.
11. **Stored XSS in Organization Name**:
    - The organization name is saved directly without sanitization and rendered in dashboard navigation headers without explicit escaping, creating a potential stored XSS vector if an attacker gains workspace invite access.
12. **Missing SAML / SSO Configuration Endpoints**:
    - Enterprise workspaces cannot configure SAML metadata, single sign-on ACS URLs, or enforce identity provider domain matching.
13. **Lack of Webhook Secret Viewing & Regeneration**:
    - External webhook integration secrets cannot be inspected, regenerated, or configured with custom signature signing secrets in settings.
14. **Silent Failure on Resend API Errors**:
    - In `route.ts:170`, if `sendTransactionalEmail` throws an error due to invalid recipient email or domain reputation block, the invitation record remains in the database with status `pending`, but the user receives an unhandled 500 error without an informative UI message.

---

## What's missing vs full product vision

1. **Full Team Management Dashboard UI**:
   - A comprehensive team roster table showing members, roles (`Owner`, `Admin`, `Member`, `Auditor`), last login timestamps, status badges, and action menus (`Change Role`, `Resend Invite`, `Remove Member`).
2. **Interactive Autonomy Rule Configurator**:
   - A governance matrix allowing admins to set per-employee confidence thresholds, human-in-the-loop triggers, and financial spending limits.
3. **Comprehensive Settings Audit Trail**:
   - Dedicated settings history tab displaying who changed workspace parameters, rotated keys, invited members, or altered autonomy tiers.
4. **Two-Factor Authentication (2FA) Enforcement**:
   - Enterprise organizations require a setting to enforce 2FA across all workspace members, rejecting logins that lack TOTP verification.
5. **IP Address Allowlisting for Dashboard Access**:
   - Ability for security-conscious tenants to restrict dashboard logins to corporate VPN IP ranges.
6. **Self-Serve Organization Deletion & Data Scrubbing Saga**:
   - Fully automated account teardown that revokes Nango OAuth tokens, cancels Stripe subscriptions, terminates running Temporal workflows, and scrubs RLS database rows.
7. **Custom Email Sender Domain (White-Labeling)**:
   - Setting to connect custom domain DKIM/SPF records via Resend so outbound AI emails send from `@company.com` instead of the default Darex notification address.
8. **Webhook Secret Visibility & Key Management**:
   - UI and endpoints to view, rotate, and manage HMAC signing secrets for inbound and outbound webhooks.

---

## What to add for full SaaS

### 1. Implement Member Management Endpoints
Create `apps/dashboard/app/api/settings/members/[id]/route.ts`:
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole } from '@/lib/rbac';
import { redisClient } from '@/lib/redis';

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: Insufficient privileges' }, { status: 403 });
    }

    // Protect organization owner
    const targetUser = await client.query(
      `SELECT role FROM users WHERE id = $1 AND org_id = $2`,
      [params.id, orgId]
    );
    if (targetUser.rowCount === 0) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (targetUser.rows[0].role === 'owner') {
      return NextResponse.json({ error: 'Cannot remove organization owner' }, { status: 400 });
    }

    // Cannot remove yourself if you are an admin
    if (params.id === userId) {
      return NextResponse.json({ error: 'Cannot remove your own account from settings' }, { status: 400 });
    }

    await client.query(
      `DELETE FROM users WHERE id = $1 AND org_id = $2`,
      [params.id, orgId]
    );

    // Revoke active sessions in Redis
    await redisClient.set(`revoked_user:${params.id}`, '1', 'EX', 86400 * 7);

    // Audit log entry
    await client.query(
      `INSERT INTO audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, risk_class, result_status)
       VALUES ($1, 'user', $2, 'member.removed', 'user', $3, 'high', 'success')`,
      [orgId, userId, params.id]
    );

    return NextResponse.json({ success: true, removedUserId: params.id });
  } finally {
    client.release();
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, orgId, userId);
    if (role !== 'owner') {
      return NextResponse.json({ error: 'Forbidden: Only organization owners can change member roles.' }, { status: 403 });
    }

    const { role: newRole } = await request.json();
    const validRoles = ['admin', 'member', 'auditor'];
    if (!validRoles.includes(newRole)) {
      return NextResponse.json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` }, { status: 400 });
    }

    // Verify target user exists in this tenant
    const existing = await client.query(
      `SELECT role FROM users WHERE id = $1 AND org_id = $2`,
      [params.id, orgId]
    );
    if (existing.rowCount === 0) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (existing.rows[0].role === 'owner') {
      return NextResponse.json({ error: 'Cannot modify role of workspace owner' }, { status: 400 });
    }

    const res = await client.query(
      `UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 AND org_id = $3 RETURNING id, email, role`,
      [newRole, params.id, orgId]
    );

    // Invalidate cached role in Redis so subsequent requests enforce new privileges immediately
    await redisClient.del(`session_role:${params.id}`);

    // Log to audit table
    await client.query(
      `INSERT INTO audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, risk_class, result_status, metadata)
       VALUES ($1, 'user', $2, 'member.role_updated', 'user', $3, 'medium', 'success', $4)`,
      [orgId, userId, params.id, JSON.stringify({ oldRole: existing.rows[0].role, newRole })]
    );

    return NextResponse.json({ user: res.rows[0] });
  } finally {
    client.release();
  }
}
```

### 2. Implement Autonomy Mutation Route (`PATCH /api/settings/autonomy`)
In `apps/dashboard/app/api/settings/autonomy/route.ts`:
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole } from '@/lib/rbac';

export async function PATCH(request: Request) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: Admin or Owner role required' }, { status: 403 });
    }

    const { employeeRole, autonomyTier, minConfidence, reversibility } = await request.json();

    const validTiers = ['notice', 'draft', 'act_internally', 'act_externally'];
    if (!validTiers.includes(autonomyTier)) {
      return NextResponse.json({ error: `Invalid autonomy tier. Must be one of: ${validTiers.join(', ')}` }, { status: 400 });
    }

    if (minConfidence !== undefined && (minConfidence < 0 || minConfidence > 1)) {
      return NextResponse.json({ error: 'minConfidence must be between 0.0 and 1.0' }, { status: 400 });
    }

    await client.query(
      `INSERT INTO employee_autonomy_rules (
         org_id, employee_role, autonomy_tier, min_confidence, reversibility, updated_at
       ) VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (org_id, employee_role) DO UPDATE SET
         autonomy_tier = EXCLUDED.autonomy_tier,
         min_confidence = COALESCE(EXCLUDED.min_confidence, employee_autonomy_rules.min_confidence),
         reversibility = COALESCE(EXCLUDED.reversibility, employee_autonomy_rules.reversibility),
         updated_at = NOW()`,
      [orgId, employeeRole, autonomyTier, minConfidence ?? 0.85, reversibility ?? 'reversible']
    );

    // Record audit event
    await client.query(
      `INSERT INTO audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, risk_class, result_status, metadata)
       VALUES ($1, 'user', $2, 'settings.autonomy_updated', 'employee_role', $3, 'high', 'success', $4)`,
      [orgId, userId, employeeRole, JSON.stringify({ autonomyTier, minConfidence, reversibility })]
    );

    return NextResponse.json({ success: true, employeeRole, autonomyTier });
  } finally {
    client.release();
  }
}
```

### 3. Rate-Limited Invitation Dispatch with Audit Logging
In `apps/dashboard/app/api/settings/route.ts` when handling `invite_member`:
```typescript
import { checkRateLimitRedis } from '@/lib/redis-rate-limit';

// Under action === 'invite_member':
const isAllowed = await checkRateLimitRedis(`invite_limit:${orgId}`, 15, 3600); // 15 invites per hour max
if (!isAllowed) {
  return NextResponse.json({
    error: 'Team invitation rate limit exceeded. Please wait an hour before inviting more members.',
  }, { status: 429 });
}

// After successful insertion:
await client.query(
  `INSERT INTO audit_events (org_id, actor_type, actor_user_id, action, target_type, target_id, risk_class, result_status, metadata)
   VALUES ($1, 'user', $2, 'member.invited', 'org_invite', $3, 'medium', 'success', $4)`,
  [orgId, userId, inviteId, JSON.stringify({ email: targetEmail, role: targetRole })]
);
```

### 4. Implement Self-Serve Organization Teardown Saga (`DELETE /api/settings/org`)
Create `apps/dashboard/app/api/settings/org/route.ts`:
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole } from '@/lib/rbac';
import { cancelStripeSubscriptionForOrg } from '@/lib/billing-sync';
import { revokeAllNangoTokensForOrg } from '@/lib/nango-auth';

export async function DELETE(request: Request) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, orgId, userId);
    if (role !== 'owner') {
      return NextResponse.json({ error: 'Only workspace owners may delete the organization.' }, { status: 403 });
    }

    const { confirmationName } = await request.json();
    const orgRes = await client.query('SELECT name FROM orgs WHERE id = $1', [orgId]);
    if (orgRes.rows.length === 0) return NextResponse.json({ error: 'Org not found' }, { status: 404 });
    
    if (orgRes.rows[0].name !== confirmationName) {
      return NextResponse.json({ error: 'Confirmation organization name does not match.' }, { status: 400 });
    }

    // Step 1: Cancel active Stripe subscriptions
    await cancelStripeSubscriptionForOrg(orgId);

    // Step 2: Revoke third-party Nango OAuth connection tokens
    await revokeAllNangoTokensForOrg(orgId);

    // Step 3: Cascading delete organization and all associated RLS rows
    await client.query('DELETE FROM orgs WHERE id = $1', [orgId]);

    return NextResponse.json({ success: true, message: 'Organization successfully deleted.' });
  } finally {
    client.release();
  }
}
```

### 5. Database Migration: `025_settings_and_security.sql`
```sql
-- Migration: 025_settings_and_security.sql
-- Enforces organization security policies, SAML configs, and role history tracking

CREATE TABLE IF NOT EXISTS org_security_settings (
  org_id UUID PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  enforce_2fa BOOLEAN DEFAULT FALSE,
  allowed_ip_ranges TEXT[] DEFAULT '{}',
  session_timeout_minutes INT DEFAULT 1440, -- 24 hours
  webhook_signing_secret VARCHAR(64) NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  custom_email_domain VARCHAR(255),
  custom_domain_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS org_role_change_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  changed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  old_role VARCHAR(32) NOT NULL,
  new_role VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_role_change_org ON org_role_change_logs(org_id, created_at DESC);
```

### 6. Team Members Management UI Component (`settings/team-panel.tsx`)
```tsx
'use client';

import { useState } from 'react';
import { UserPlus, Trash2, Shield, MoreVertical } from 'lucide-react';

interface Member {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'member' | 'auditor';
  created_at: string;
}

export function TeamManagementPanel({ initialMembers }: { initialMembers: Member[] }) {
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const handleRoleChange = async (userId: string, newRole: string) => {
    setLoadingId(userId);
    try {
      const res = await fetch(`/api/settings/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) throw new Error('Failed to update role');
      const data = await res.json();
      setMembers(members.map(m => m.id === userId ? { ...m, role: data.user.role } : m));
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoadingId(null);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!confirm('Are you sure you want to remove this member? This will immediately revoke their access.')) return;
    setLoadingId(userId);
    try {
      const res = await fetch(`/api/settings/members/${userId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove member');
      setMembers(members.filter(m => m.id !== userId));
    } catch (err: any) {
      alert(err.message);
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-900 shadow rounded-lg border border-gray-200 dark:border-gray-800 p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Team Members</h2>
          <p className="text-sm text-gray-500">Manage user roles and dashboard access permissions.</p>
        </div>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {members.map(member => (
          <div key={member.id} className="py-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900 dark:text-gray-100">{member.email}</p>
              <p className="text-xs text-gray-500">Joined {new Date(member.created_at).toLocaleDateString()}</p>
            </div>
            <div className="flex items-center space-x-3">
              {member.role === 'owner' ? (
                <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                  Owner
                </span>
              ) : (
                <select
                  disabled={loadingId === member.id}
                  value={member.role}
                  onChange={(e) => handleRoleChange(member.id, e.target.value)}
                  className="text-xs border border-gray-300 dark:border-gray-700 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="auditor">Auditor</option>
                </select>
              )}
              {member.role !== 'owner' && (
                <button
                  disabled={loadingId === member.id}
                  onClick={() => handleRemoveMember(member.id)}
                  className="p-1.5 text-gray-400 hover:text-red-600 transition"
                  title="Remove Member"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## Fix priority

- **P0**: Implement member removal (`DELETE /api/settings/members/[id]`) and role editing (`PATCH /api/settings/members/[id]`) with Redis session revocation so organizations can revoke access from departed employees.
- **P1**: Implement `PATCH /api/settings/autonomy` so administrators can configure employee autonomy tiers rather than viewing a cosmetic read-only list.
- **P1**: Add rate limiting to member invite dispatch (`checkRateLimitRedis`) to prevent transactional email spamming.
- **P1**: Record all settings mutations (name changes, key rotations, autonomy changes) into `audit_events` for security compliance.
- **P2**: Implement self-serve workspace deletion (`DELETE /api/settings/org`) with cascading cleanup and Stripe cancellation for GDPR compliance.
- **P2**: Add 2FA enforcement and IP allowlisting in `org_security_settings` for enterprise workspaces.
- **P2**: Implement webhook secret viewing and regeneration interface in Settings.

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Settings POST mutations RBAC | P0 | `app/api/settings/route.ts` | 🟢 Done | `canManageOrgSettings` retained |
| 2 | Suppressions DELETE lacked RBAC | P0 | `suppressions/route.ts` | 🟢 Done | owner/admin gate |
| 3 | Seat limit on invite | P0 | settings invite_member | 🟢 Done | `checkSeatAvailability` via `@/lib/usage-gate` |
| 4 | Member remove / role change API | P0 | `settings/members/[id]` | 🟢 Done | DELETE + PATCH; owner-only role change; audit |
| 5 | Autonomy PATCH | P1 | `settings/autonomy` | 🟢 Done | PATCH updates tier 1-4 with RBAC + audit |
| 6 | Invite rate limit | P1 | settings invite | 🟢 Done | `denyIfLimited(orgId, 'invite')` 15/hour |
