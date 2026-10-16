# Integrations & Connectors Audit

## Status: partial (OAuth honesty + health ping + multi-account schema shipped; operator Nango client IDs still external)

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Expired/missing Nango credentials must return honest reconnect (connected:false, reconnectUrl) | P0 | `services/connectors/src/client.ts`, `apps/dashboard/app/api/integrations/**` | 🟢 Done | `proxyRequest` / status / ping / connect / test / nango-token return `connected:false` + `reconnectUrl:'/connectors'` on missing or 401/403/invalid_grant. |
| 2 | Unset NEXT_PUBLIC_NANGO_PUBLIC_KEY hard-fails client popups | P0 | `apps/dashboard/lib/nango-client.ts`, `connectors/page.tsx` | 🟢 Done | Client returns structured failure (no throw); connectors page admin banner when `nango.publicKeyConfigured===false`. |
| 3 | Unregistered OAuth client credentials for connectors | P0 | Nango UI + `nango-token` / GET integrations | 🟢 Done | App already gates on `oauthConfigured===false` with honest missingConfigReason + nangoUiUrl; cannot register third-party client IDs in code. |
| 4 | Single-account per provider constraint | P1 | `infra/db/migrations/098_*.sql`, org_connectors | 🟢 Done | Migration adds `account_id` (+ health columns) and unique `(org_id, connector_key, account_id)`. |
| 5 | Silent token revocation / proactive health | P1 | `api/integrations/[provider]/ping` | 🟢 Done | Live ping route updates `health_status` / latency / last_error; revoked on 401/403. |
| 6 | Dead connector registry entries (linkedin, apollo) | P2 | `connector-registry.ts` | 🟢 Done | Removed dead meta entries not present in INTEGRATION_CATALOG. |
| 7 | Redis 429 backoff / audit / Google Ads contradiction | P2 | `client.ts`, integrations route, catalog | 🟢 Done | In-process Retry-After cooldown on 429; audit_events on connect/disconnect; Google Ads demoted to `catalog_only` until developer token is documented as required. |
| 8 | Connector mutations had no RBAC (any member/auditor could connect, disconnect, paste BYOK keys, change config, ping) — 27sept BIZ-S02/S03 | P0 | `app/api/integrations/**`, `lib/connector-rbac.ts` | 🟡 Unit-tested | Owner/admin guard on every mutating connector route; `update_config` + BYOK connects audited. Not yet exercised on a live stack. |
| 9 | Provider OAuth audit: which providers have real OAuth config; honest 'needs setup'; public-key detection | P1 | `api/integrations/route.ts`, `connectors/page.tsx`, `connectors/[id]/page.tsx`, `nango-client.ts` | 🟡 Code done, credentials 🔴 | `oauthConfigured` is computed live from Nango configs per provider; cards show a "Needs setup" badge and skip the popup, the detail page does the same, and a missing `NEXT_PUBLIC_NANGO_PUBLIC_KEY` is surfaced by the grid banner and `startRealNangoOAuth`. 🔴 Human-only: real OAuth client IDs/secrets for each provider (Google, Meta, HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom, GitHub, QuickBooks, Microsoft) must be registered in the Nango UI, plus a Google Ads developer token and `NEXT_PUBLIC_NANGO_PUBLIC_KEY`. Which are configured is per deployment; the live `/api/integrations` response is the source of truth. Step-by-step console, callback, scope and check for each: [integrations-credentials-runbook.md](integrations-credentials-runbook.md). |

---

---

The integrations and connectors subsystem (`apps/dashboard/lib/integrations-catalog.ts`, `connector-registry.ts`, `nango-server.ts`, and `apps/dashboard/app/api/integrations/*`) manages third-party OAuth and API connectivity across 27 business tools via Nango, plus direct BYOK paths for WhatsApp Cloud API and Razorpay. It adheres strictly to anti-fabrication standards (never claims "connected" without live provider verification) and implements tenant isolation on OAuth confirmation callbacks.

However, **`NEXT_PUBLIC_NANGO_PUBLIC_KEY` is frequently missing in local setups** (blocking all browser popup flows), 8 out of 14 core connectors lack registered client IDs, tenants are restricted to a single connection per provider (preventing multi-inbox setups), and there is zero proactive background health monitoring for revoked OAuth tokens, causing agent tool calls to fail midway through customer interactions.

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Database-Driven Registry Architecture**:
   - `apps/dashboard/lib/connector-registry.ts:81-263`:
     - `listConnectorDefs()` queries `connector_defs` table, mapping 27 integration types with associated risk classifications (`low`, `medium`, `high`, `critical`) and MCP tool bindings.
     - Automatically seeds default connector definitions (`ensureConnectorDefsSeeded`, lines 429-440) if empty.
2. **Honest Connection Verification (No Fabricated Status)**:
   - `apps/dashboard/app/api/integrations/route.ts:93-117`:
     - Verifies connection state strictly through live provider checks:
       - Nango connection check via `nangoConnectionExists` (`nango-server.ts:148`).
       - Verified WhatsApp BYOK credentials in `channels.meta` (`route.ts:30-35`).
       - Verified Razorpay per-org API keys (`route.ts:110-116`).
     - Never marks an integration as connected based on client-supplied claims.
3. **Defensive Multi-Tenant OAuth Confirmation**:
   - `apps/dashboard/app/api/integrations/nango-token/route.ts:101-107`:
     - Validates incoming `connectionId` against the authenticated organization's allowed ID prefix (`${orgId}_${provider}`), preventing cross-tenant connection hijacking.
     - Re-verifies connection existence on Nango's backend before updating `channels.status = 'connected'`.
4. **Live Diagnostic Ping Suites**:
   - `services/connectors/src/test-connection.ts:25-88`:
     - `pingNangoProvider` executes authenticated test requests through Nango proxy to real endpoints (e.g. `gmail: GET /gmail/v1/users/me/profile`, `stripe: GET /v1/balance`).
     - Direct live pings for WhatsApp (`graph.facebook.com`) and Razorpay (`api.razorpay.com`) with 15-second timeouts.
5. **Connection Pool Safety**:
   - `apps/dashboard/app/api/integrations/route.ts:89, 135`:
     - Unconditionally releases client connections in `finally` blocks.
6. **Encrypted Secret Storage**:
   - Custom BYOK credentials (e.g. Meta tokens, Twilio Auth tokens) are stored encrypted in Postgres JSONB columns.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Unset Nango Public Key Hard-Fails Client-Side Popups (`apps/dashboard/lib/nango-client.ts:79-86`) (P0)**:
   - *User Impact*: Complete failure of OAuth connection buttons. Users click "Connect Google" or "Connect HubSpot" and receive an immediate JavaScript exception.
   - *Code Cause*: `startRealNangoOAuth` throws `new Error('Nango public key is not configured (NEXT_PUBLIC_NANGO_PUBLIC_KEY)')` without graceful fallback UI or administrative warning banner.
2. **Unregistered OAuth Client Credentials for 8 of 14 Core Connectors (P0)**:
   - *User Impact*: 400 Bad Request / "Invalid Client ID" errors inside third-party OAuth popups.
   - *Code Cause*: 8 critical connectors (HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom, Google Ads) do not have registered OAuth application credentials configured in Nango. The UI advertises them as available, leading to user frustration upon clicking.
3. **Single-Account per Provider Constraint (`infra/db/migrations/015_packs.sql:35`, `apps/dashboard/app/api/integrations/route.ts:95-115`) (P1)**:
   - *User Impact*: Businesses cannot connect multiple company inboxes (e.g. `leasing@company.com` and `sales@company.com`) or multiple WhatsApp lines.
   - *Code Cause*: The database schema uses a composite primary key on `(org_id, provider)` in `org_connectors`. Connecting a second account overwrites the first.
4. **Token Expiry Desynchronization on Long-Running Workflows**:
   - *User Impact*: Workflows abort with HTTP 401 Unauthorized after 60 minutes.
   - *Code Cause*: Nango tokens expire during multi-hour batch runs. When `executeAutonomousToolAction` encounters a 401 error, it does not instruct Nango to perform a synchronous token refresh and retry before returning an error.
5. **Silent Token Revocation Failures**:
   - *User Impact*: The dashboard displays an integration as "Connected", but agent attempts to use the tool fail with permission errors.
   - *Code Cause*: When an admin revokes app permissions from within Google Account Security, Nango does not receive an automatic revocation webhook. The connection remains marked connected until an agent action fails.
6. **Dead Connector Registry Entries (`apps/dashboard/lib/connector-registry.ts:251-262`)**:
   - *User Impact*: Dead code and confusing administrative catalog listings.
   - *Code Cause*: `CONNECTOR_REGISTRY_META` defines risk classes for `linkedin` and `apollo`, but neither exists in `INTEGRATION_CATALOG`.
7. **Google Ads Live Status Contradiction (`apps/dashboard/lib/integrations-catalog.ts:163`)**:
   - *User Impact*: Successful OAuth connection followed by 100% agent tool execution failure.
   - *Code Cause*: Google Ads is marked `executorStatus: 'live'`, but requires `GOOGLE_ADS_DEVELOPER_TOKEN`. When absent, tool calls fail with 500 errors.
8. **Missing Third-Party API Rate Limit Backoff Handling**:
   - *User Impact*: Temporary IP or account bans by third-party APIs (e.g. HubSpot, Shopify).
   - *Code Cause*: When an external API returns HTTP 429, the system immediately retries instead of respecting the `Retry-After` header and cooling down via Redis.
9. **No Audit Logging on Integration Mutations**:
   - *User Impact*: Inability to see who connected or disconnected third-party integrations.
   - *Code Cause*: Endpoints do not write to `audit_events`.
10. **Race Condition in Parallel Tool Calls Sharing OAuth Refresh**:
    - *User Impact*: "Invalid Grant / Token already used" errors.
    - *Code Cause*: If two child agent workflows attempt to use an expired OAuth token simultaneously, both trigger simultaneous refresh requests to Google/HubSpot. The second refresh invalidates the first.
11. **Absence of Webhook Auto-Registration**:
    - *User Impact*: Inbound events from HubSpot or Shopify are not received until webhooks are manually registered in provider dashboards.
    - *Code Cause*: OAuth callback flows do not invoke external provider webhook registration APIs.
12. **Missing Granular OAuth Scopes Selection**:
    - *User Impact*: Security compliance rejection by enterprise IT teams.
    - *Code Cause*: Nango requests maximal scopes (`gmail.modify`, `drive`) without offering read-only or folder-specific scope configuration.

---

## What's missing vs full vision

1. **Multi-Account Connector Architecture**:
   - Schema and UI supporting multiple accounts per provider (e.g. 3 Google accounts, 2 WhatsApp numbers) with custom labels (`"Support Inbox"`, `"Executive Assistant"`).
2. **Proactive Background Health Check Worker**:
   - Scheduled Temporal workflow pinging all connected accounts every 6 hours and alerting administrators if tokens are revoked or expired.
3. **Live Diagnostic Health & Latency Dashboard**:
   - Interactive testing interface in Settings showing round-trip ping latencies, current token status, and last successful sync time.
4. **Redis-Backed Rate Limit Cooldown Middleware**:
   - Intelligent backoff pausing outgoing tool requests to a provider when HTTP 429 `Retry-After` is received.
5. **Interactive OAuth App Configuration Wizard**:
   - Setup modal guiding workspace admins on creating custom Google Cloud or Meta developer apps if they want to use their own client ID and secret.
6. **Granular Permission Scopes Editor**:
   - Checkbox list allowing admins to restrict agent permissions (e.g. "Read Only", "Send Drafts Only", "Full Send Access").
7. **Automated Provider Webhook Subscriptions**:
   - Seamless registration of webhook endpoints on third-party platforms upon OAuth connection completion.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Multi-Account Connectors & Health (`038_multi_account_and_oauth_health.sql`)
```sql
-- 1. Support multiple accounts per provider
ALTER TABLE org_connectors
  DROP CONSTRAINT IF EXISTS org_connectors_pkey;

ALTER TABLE org_connectors
  ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT 'primary',
  ADD COLUMN IF NOT EXISTS account_label TEXT,
  ADD COLUMN IF NOT EXISTS email_address TEXT,
  ADD COLUMN IF NOT EXISTS health_status TEXT NOT NULL DEFAULT 'healthy' CHECK (health_status IN ('healthy', 'degraded', 'revoked', 'rate_limited')),
  ADD COLUMN IF NOT EXISTS last_health_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_ping_latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS last_error_message TEXT,
  ADD PRIMARY KEY (org_id, provider, account_id);

CREATE INDEX IF NOT EXISTS idx_org_connectors_health
  ON org_connectors(org_id, health_status);

-- 2. Audit table for connector events
CREATE TABLE IF NOT EXISTS connector_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('connected', 'disconnected', 'refreshed', 'revoked', 'health_check_failed')),
  user_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE connector_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_audit_isolation ON connector_audit_events
  FOR ALL USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
```

### 2. Multi-Account Connection Listing & Registration Route (`apps/dashboard/app/api/integrations/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { client, orgId } = await getScopedClient();
  try {
    const res = await client.query(
      `SELECT provider, account_id, account_label, email_address, status, health_status,
              last_health_check_at, last_ping_latency_ms, last_error_message
       FROM org_connectors
       WHERE org_id = $1
       ORDER BY provider ASC, account_id ASC`,
      [orgId]
    );

    return NextResponse.json({ connectors: res.rows });
  } finally {
    client.release();
  }
}

export async function DELETE(req: NextRequest) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const { provider, accountId = 'primary' } = await req.json();
    if (!provider) {
      return NextResponse.json({ error: 'Provider is required' }, { status: 400 });
    }

    await client.query(
      `DELETE FROM org_connectors
       WHERE org_id = $1 AND provider = $2 AND account_id = $3`,
      [orgId, provider, accountId]
    );

    await client.query(
      `INSERT INTO connector_audit_events (org_id, provider, account_id, event_type, user_id)
       VALUES ($1, $2, $3, 'disconnected', $4)`,
      [orgId, provider, accountId, userId]
    );

    return NextResponse.json({ success: true });
  } finally {
    client.release();
  }
}
```

### 3. Dedicated Live Connector Ping Diagnostic Route (`apps/dashboard/app/api/integrations/[provider]/[accountId]/ping/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { pingNangoProvider } from '@darex/connectors';

export async function POST(
  req: NextRequest,
  { params }: { params: { provider: string; accountId: string } }
) {
  const { client, orgId } = await getScopedClient();
  const startTime = Date.now();

  try {
    const connectionId = `${orgId}_${params.provider}_${params.accountId}`;
    const result = await pingNangoProvider(params.provider, connectionId);
    const latencyMs = Date.now() - startTime;

    const newHealth = result.ok ? 'healthy' : 'degraded';
    await client.query(
      `UPDATE org_connectors
       SET health_status = $1,
           last_health_check_at = NOW(),
           last_ping_latency_ms = $2,
           last_error_message = $3,
           updated_at = NOW()
       WHERE org_id = $4 AND provider = $5 AND account_id = $6`,
      [newHealth, latencyMs, result.error || null, orgId, params.provider, params.accountId]
    );

    return NextResponse.json({
      success: result.ok,
      latencyMs,
      error: result.error || null
    });
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    await client.query(
      `UPDATE org_connectors
       SET health_status = 'revoked',
           last_health_check_at = NOW(),
           last_ping_latency_ms = $1,
           last_error_message = $2,
           updated_at = NOW()
       WHERE org_id = $3 AND provider = $4 AND account_id = $5`,
      [latencyMs, err.message, orgId, params.provider, params.accountId]
    );

    return NextResponse.json({ success: false, latencyMs, error: err.message }, { status: 502 });
  } finally {
    client.release();
  }
}
```

### 4. Interactive Integrations UI with Multi-Account & Health Badges (`apps/dashboard/app/(dashboard)/settings/integrations/page.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import {
  Link2,
  CheckCircle2,
  AlertCircle,
  XCircle,
  RefreshCw,
  Plus,
  Trash2,
  ShieldCheck,
  Zap
} from 'lucide-react';
import { toast } from 'sonner';

interface ConnectorItem {
  provider: string;
  account_id: string;
  account_label: string | null;
  email_address: string | null;
  status: string;
  health_status: 'healthy' | 'degraded' | 'revoked' | 'rate_limited';
  last_health_check_at: string | null;
  last_ping_latency_ms: number | null;
}

export default function IntegrationsSettingsPage() {
  const [connectors, setConnectors] = useState<ConnectorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pinging, setPinging] = useState<string | null>(null);

  const loadConnectors = async () => {
    try {
      const res = await fetch('/api/integrations');
      const data = await res.json();
      setConnectors(data.connectors || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConnectors();
  }, []);

  const handlePing = async (provider: string, accountId: string) => {
    const key = `${provider}:${accountId}`;
    setPinging(key);
    try {
      const res = await fetch(`/api/integrations/${provider}/${accountId}/ping`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        toast.success(`Connected! Latency: ${data.latencyMs}ms`);
      } else {
        toast.error(`Connection check failed: ${data.error}`);
      }
      loadConnectors();
    } finally {
      setPinging(null);
    }
  };

  const handleDisconnect = async (provider: string, accountId: string) => {
    if (!confirm(`Are you sure you want to disconnect ${provider} (${accountId})?`)) return;
    const res = await fetch('/api/integrations', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, accountId })
    });
    if (res.ok) {
      toast.success('Connector removed');
      loadConnectors();
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center justify-between pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Link2 className="w-6 h-6 text-emerald-400" />
            Integrations & Connectors
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Connect third-party business software to empower autonomous AI employees with real tools.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {connectors.map((c) => {
          const key = `${c.provider}:${c.account_id}`;
          return (
            <div
              key={key}
              className="p-5 bg-slate-900 border border-slate-800 rounded-xl flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-200 capitalize">{c.provider}</span>
                    <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded">
                      {c.account_label || c.account_id}
                    </span>
                  </div>

                  <span
                    className={`text-xs px-2 py-0.5 rounded-full capitalize font-medium flex items-center gap-1 ${
                      c.health_status === 'healthy'
                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                        : c.health_status === 'degraded'
                        ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                        : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                    }`}
                  >
                    {c.health_status === 'healthy' ? (
                      <CheckCircle2 className="w-3 h-3" />
                    ) : (
                      <AlertCircle className="w-3 h-3" />
                    )}
                    {c.health_status}
                  </span>
                </div>

                {c.email_address && (
                  <p className="text-xs text-slate-400 mt-2 font-mono">{c.email_address}</p>
                )}

                {c.last_ping_latency_ms !== null && (
                  <div className="text-xs text-slate-500 mt-2 flex items-center gap-1">
                    <Zap className="w-3 h-3 text-emerald-400" />
                    Ping: {c.last_ping_latency_ms}ms · Checked{' '}
                    {new Date(c.last_health_check_at!).toLocaleTimeString()}
                  </div>
                )}
              </div>

              <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between">
                <button
                  disabled={pinging === key}
                  onClick={() => handlePing(c.provider, c.account_id)}
                  className="flex items-center gap-1 text-xs text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 rounded transition"
                >
                  <RefreshCw className={`w-3 h-3 ${pinging === key ? 'animate-spin' : ''}`} />
                  Test Ping
                </button>

                <button
                  onClick={() => handleDisconnect(c.provider, c.account_id)}
                  className="text-xs text-rose-400 hover:text-rose-300 transition flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" /> Disconnect
                </button>
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

- **P0**: Configure and validate `NEXT_PUBLIC_NANGO_PUBLIC_KEY` so OAuth connection popups initialize reliably.
- **P0**: Register valid OAuth client credentials in Nango for core business connectors (HubSpot, Stripe, Slack, Shopify).
- **P1**: Deploy `038_multi_account_and_oauth_health.sql` to support multiple accounts per provider.
- **P1**: Build automated background health check worker to detect revoked OAuth tokens proactively.
- **P2**: Implement Redis rate limit cooldown middleware to handle HTTP 429 responses gracefully.
- **P2**: Prune dead connector registry entries (`linkedin`, `apollo`).
