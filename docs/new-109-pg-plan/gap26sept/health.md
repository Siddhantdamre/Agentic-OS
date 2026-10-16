# Health & Readiness Audit

## Status: ready probe + degradation banner shipped; pool connect wrap verified

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Zero readiness verification — `/api/health` liveness only | P0 | `apps/dashboard/app/api/health/ready/route.ts` | 🟢 Done | `GET /api/health/ready` probes Postgres, Redis, Temporal, LiteLLM with 1500ms timeouts; unconfigured deps → `not_configured` (do not fail ready); 5s cache; 503 only when Postgres/pool hard-fail |
| 2 | DB pool waiting count blind | P0 | `apps/dashboard/app/api/health/ready/route.ts` | 🟢 Done | Reports `pool.waitingCount` / total / idle when exposed; marks error when waiting ≥ 5 |
| 3 | Temporal / Redis / LiteLLM unmonitored | P0/P1 | `apps/dashboard/app/api/health/ready/route.ts` | 🟢 Done | Each check gated on env (`TEMPORAL_ADDRESS`, `REDIS_URL`, `LITELLM_BASE_URL`); TCP/HTTP probes only when configured |
| 4 | SystemDegradationBanner missing | P2 | `apps/dashboard/components/SystemDegradationBanner.tsx` + AppShell mount | 🟢 Done | Client polls `/api/health/ready` every 30s; shows degraded/unhealthy only — no fake outages |
| 5 | Node memory / event-loop telemetry | P2 | `apps/dashboard/lib/runtime-telemetry.ts` | 🟢 Done | `process.memoryUsage` + setImmediate delay sample on `/api/health` and `/api/health/ready` |
| 6 | Global `pool.connect` wrapClientRelease | P0 | `apps/dashboard/lib/db.ts:35-108` | 🟢 Done | Verified: `installPoolConnectGuard` wraps every `pool.connect` (promise + callback); `wrapClientRelease` RESETs `app.current_org_id` then `app.current_user_id` before return to pool; `_darexScoped` keeps `getScopedClient` / `getOrgScopedClient` idempotent |
| 7 | Authenticated diagnostics endpoint | P1 | `apps/dashboard/app/api/health/diagnostics/route.ts` | 🟢 Done | Owner/admin/auditor session; runtime + pool stats + configured-deps flags; no secrets |

---

The current `/api/health` endpoint is a static liveness probe returning `{ ok: true, service: 'dashboard' }`. While suitable for basic process liveness in load balancers, the system lacks readiness probes, dependency connectivity checks, pool exhaustion monitoring, and customer-facing degradation signals across its multi-service distributed architecture (Postgres, Redis, Temporal, TrueForge, MCP Bridge, LiteLLM, Nango, Langfuse).

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Static Liveness Probe**:
   - `apps/dashboard/app/api/health/route.ts:1-8` — `GET /api/health`:
     - Exports `dynamic = 'force-dynamic'` and returns `{ ok: true, service: 'dashboard' }` as a standard HTTP 200 JSON response.
     - `route.ts:5` explicitly documents the architectural rationale: "Liveness probe for compose / load balancers. Does not require a session." It is unauthenticated, avoids DB queries, and avoids holding pooled connections, ensuring that container orchestrators (Kubernetes/Docker) do not kill a healthy Node.js process during transient backend dependency spikes.
2. **Infrastructure Health Probes in Docker Compose**:
   - `infra/docker-compose.yml:25-30, 48-52`:
     - Infrastructure health probes exist at the Docker Compose layer for Postgres (`pg_isready -U darex`) and Redis (`redis-cli ping`), validating container startup ordering.
3. **External Verification Scripts**:
   - `infra/scripts/check-phase*.js`:
     - External operational health scripts verify migrations and basic service connectivity outside the Next.js runtime.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Zero Readiness Verification (`apps/dashboard/app/api/health/route.ts:1-8`) (P0)**:
   - *User Impact*: Black-hole routing. When PostgreSQL or Redis crashes, load balancers continue routing user traffic to the instance, resulting in 100% HTTP 500 errors across all dashboard pages.
   - *Code Cause*: `/api/health` performs zero dependency checks. It only verifies that the Node process is listening on port 3000.
2. **Database Connection Pool Exhaustion Blindness (`apps/dashboard/lib/db.ts:12-32`) (P0)**:
   - *User Impact*: Infinite loading spinners and connection deadlocks across all active sessions.
   - *Code Cause*: PostgreSQL connection pool has a strict ceiling (`max: 10`). There is no health probe checking `pool.waitingCount`. If 10 requests hang on slow analytical queries or unclosed SSE streams, new incoming requests hang forever while `/api/health` cheerfully reports 200 OK.
3. **Temporal Worker Stalling Blindness (`services/workflows/src/`) (P0)**:
   - *User Impact*: Total breakdown of autonomous actions. Customer inquiries sit in queues, but no AI agent turns ever fire.
   - *Code Cause*: The web dashboard has no awareness of whether the background Temporal worker container is alive, polling task queues, or crashed.
4. **Redis EventBus & Realtime Hub Unmonitored (`apps/dashboard/lib/event-bus.ts:50-80`)**:
   - *User Impact*: Live SSE streams disconnect with HTTP 503 while the rest of the app appears functional.
   - *Code Cause*: Health probes never issue a `redisClient.ping()` check.
5. **LiteLLM Gateway Blindness (`apps/dashboard/lib/litellm-client.ts:10-45`)**:
   - *User Impact*: AI classification and chat requests fail with 500 errors when LiteLLM is down or out of provider credits.
   - *Code Cause*: No probe checks `LITELLM_URL/health`.
6. **MCP Bridge (Port 8790) & TrueForge Sidecar Blindness**:
   - *User Impact*: Agent tool execution completely disabled without warning.
   - *Code Cause*: In-process agent execution depends on the MCP Bridge HTTP SSE server on port 8790; no probe verifies bridge availability.
7. **Risk of Unredacted Secret Leakage in Error Responses**:
   - *User Impact*: Exposure of database credentials or internal cluster hostnames to public scanners.
   - *Code Cause*: Unhandled try/catch blocks in custom health checks risk returning raw database connection error strings.
8. **Binary All-or-Nothing Health Modeling**:
   - *User Impact*: Complete service dropouts on non-critical dependency degradation.
   - *Code Cause*: Lack of a "Degraded" (HTTP 200/207) state when non-essential subsystems (e.g. Langfuse tracing) are offline.
9. **No In-App Customer Degradation Notification**:
   - *User Impact*: Confused customers think their messages are being ignored.
   - *Code Cause*: The dashboard UI lacks a global status banner component to communicate ongoing partial outages.
10. **Lack of Node.js Runtime Telemetry**:
    - *User Impact*: Unnoticed memory leaks and event loop lag leading to silent container crashes.
    - *Code Cause*: Runtime heap, RSS, and event loop delays are not instrumented.
11. **Health Check Stampede Under High Scrape Frequency**:
    - *User Impact*: Deep dependency probes saturating the DB pool when monitored by external pingers every 5 seconds.
    - *Code Cause*: Lack of in-memory caching for deep readiness probe results.
12. **Probe Timeout Cascades**:
    - *User Impact*: Health checks hanging for 30 seconds when an external service is down.
    - *Code Cause*: Individual dependency checks lack strict 1500ms timeouts.
13. **Direct `pool.connect()` Checkouts Bypass Client Release RLS Reset Guard (`apps/dashboard/lib/db.ts:94-128`) (P0)**:
    - *User Impact*: Silent cross-tenant data contamination. A database connection released back to the pool retains an active `app.current_org_id` session setting. When another request checks out that same connection for an unscoped or direct pool query, it operates with the previous tenant's permissions!
    - *Code Cause*: `wrapClientRelease` is only applied when calling `getScopedClient()` or `getOrgScopedClient()`. Any call to `pool.connect()` directly (found in cancellation checks, migrations, health probes, or background tasks) bypasses `wrapClientRelease`. If session variables were configured, releasing the connection returns it to the pool in a "poisoned" state without executing `RESET app.current_org_id; RESET app.current_user_id;`.
    - *Fix*: Patch `pool.connect` at the pool instance level so every single client returned by the pool automatically executes `wrapClientRelease(client)`:
      ```typescript
      const originalConnect = pool.connect.bind(pool);
      pool.connect = async function(...args: any[]) {
        const client = await (originalConnect as any)(...args);
        wrapClientRelease(client);
        return client;
      };
      ```

---

## What's missing vs full vision

1. **Dual Liveness and Readiness Architecture**:
   - `/api/health/live`: Fast, zero-dependency process check for orchestrator restart decisions.
   - `/api/health/ready`: Comprehensive dependency probe checking Postgres, Redis, Temporal, and LiteLLM.
2. **Authenticated Deep Diagnostics Console (`/api/health/diagnostics`)**:
   - Role-gated endpoint (`owner`/`admin`) returning millisecond latencies, active socket handles, and pool statistics.
3. **Background Worker Heartbeat Tracking Table**:
   - Table `system_worker_heartbeats` where Temporal workers write periodic heartbeats, allowing the web app to detect stalled workers.
4. **Global In-App Service Degradation Banner**:
   - Non-intrusive notification banner informing dashboard users when specific background services (e.g. WhatsApp outbound or live stream) are experiencing temporary degradation.
5. **Node.js Process Telemetry**:
   - Heap memory usage, active handles, event loop lag, and process uptime tracking.
6. **Cached Readiness Probe with 5-Second TTL**:
   - Protecting backend services from pinger stampedes by caching readiness results in memory.
7. **Strict Timeout Boundaries on All Dependency Probes**:
   - 1.5s hard timeouts on every individual check, ensuring the readiness endpoint responds in <2s even during complete network partitions.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Worker Heartbeats Schema (`047_system_health_and_heartbeats.sql`)
```sql
-- 1. Table for tracking Temporal and background worker heartbeats
CREATE TABLE IF NOT EXISTS system_worker_heartbeats (
  worker_id TEXT PRIMARY KEY,
  service_name TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  hostname TEXT,
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worker_heartbeats_check
  ON system_worker_heartbeats (service_name, last_heartbeat_at DESC);
```

### 2. Comprehensive Readiness Probe Route (`apps/dashboard/app/api/health/ready/route.ts`)
```typescript
import { NextResponse } from 'next/server';
import { getDbPool } from '@/lib/db';
import { getRedisClient } from '@/lib/redis';

// In-memory probe cache to prevent DB stampede from frequent scrapers
let cachedResult: { timestamp: number; payload: any; status: number } | null = null;
const CACHE_TTL_MS = 5000;

export async function GET() {
  const now = Date.now();
  if (cachedResult && now - cachedResult.timestamp < CACHE_TTL_MS) {
    return NextResponse.json(cachedResult.payload, { status: cachedResult.status });
  }

  const timeoutMs = 1500;
  const runWithTimeout = <T>(promise: Promise<T>): Promise<T> => {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
    ]);
  };

  const pool = getDbPool();
  const redis = getRedisClient();
  const checks: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

  // 1. PostgreSQL Check
  const pgStart = Date.now();
  try {
    await runWithTimeout(pool.query('SELECT 1'));
    checks.postgres = { ok: true, latencyMs: Date.now() - pgStart };
  } catch (err: any) {
    checks.postgres = { ok: false, error: 'Database unreachable' };
  }

  // 2. Redis Check
  const redisStart = Date.now();
  if (redis) {
    try {
      await runWithTimeout(redis.ping());
      checks.redis = { ok: true, latencyMs: Date.now() - redisStart };
    } catch {
      checks.redis = { ok: false, error: 'Redis unreachable' };
    }
  } else {
    checks.redis = { ok: false, error: 'Redis unconfigured' };
  }

  // 3. Database Pool Health
  checks.db_pool = {
    ok: pool.waitingCount < 5,
    error: pool.waitingCount >= 5 ? `Pool exhausted: ${pool.waitingCount} requests waiting` : undefined
  };

  // 4. LiteLLM Gateway Check
  const litellmStart = Date.now();
  try {
    const litellmUrl = process.env.LITELLM_URL || 'http://localhost:4000';
    const res = await runWithTimeout(fetch(`${litellmUrl}/health`, { method: 'GET' }));
    checks.litellm = { ok: res.ok, latencyMs: Date.now() - litellmStart };
  } catch {
    checks.litellm = { ok: false, error: 'LiteLLM unreachable' };
  }

  const isHealthy = checks.postgres.ok && checks.db_pool.ok;
  const isDegraded = !checks.redis.ok || !checks.litellm.ok;

  const status = !isHealthy ? 'unhealthy' : isDegraded ? 'degraded' : 'healthy';
  const httpCode = !isHealthy ? 503 : 200;

  const payload = {
    status,
    timestamp: new Date().toISOString(),
    checks
  };

  cachedResult = { timestamp: now, payload, status: httpCode };
  return NextResponse.json(payload, { status: httpCode });
}
```

### 3. Authenticated Deep Diagnostics Route (`apps/dashboard/app/api/health/diagnostics/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient, getDbPool } from '@/lib/db';
import { loadHumanRole } from '@/lib/rbac';

export async function GET(req: NextRequest) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const pool = getDbPool();
    const memory = process.memoryUsage();

    // Check Temporal worker heartbeat
    const heartbeatRes = await client.query(
      `SELECT worker_id, service_name, last_heartbeat_at
       FROM system_worker_heartbeats
       WHERE last_heartbeat_at >= NOW() - INTERVAL '5 minutes'
       ORDER BY last_heartbeat_at DESC`
    );

    return NextResponse.json({
      environment: process.env.NODE_ENV,
      version: process.env.npm_package_version || '1.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
        rssMb: Math.round(memory.rss / 1024 / 1024)
      },
      dbPool: {
        totalConnections: pool.totalCount,
        idleConnections: pool.idleCount,
        waitingRequests: pool.waitingCount,
        maxLimit: 10
      },
      activeWorkers: heartbeatRes.rows
    });
  } finally {
    client.release();
  }
}
```

### 4. Global Service Degradation Banner Component (`components/SystemDegradationBanner.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';

export function SystemDegradationBanner() {
  const [degraded, setDegraded] = useState(false);
  const [message, setMessage] = useState('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    async function checkHealth() {
      try {
        const res = await fetch('/api/health/ready');
        const data = await res.json();
        if (data.status === 'degraded') {
          setDegraded(true);
          const failing = Object.entries(data.checks || {})
            .filter(([_, v]: [string, any]) => !v.ok)
            .map(([k]) => k)
            .join(', ');
          setMessage(`Some background features are temporarily degraded (${failing}). Chat and data remain safe.`);
        } else {
          setDegraded(false);
        }
      } catch {
        setDegraded(true);
        setMessage('Network connectivity to Darex backend services is unstable.');
      }
    }

    checkHealth();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, []);

  if (!degraded || dismissed) return null;

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 text-xs text-amber-300 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
        <span>{message}</span>
      </div>
      <button onClick={() => setDismissed(true)} className="text-amber-400 hover:text-amber-200">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
```

### 5. Temporal Worker Heartbeat Publisher (`services/workflows/src/worker-heartbeat.ts`)
```typescript
import { getPool } from '@/lib/db';
import os from 'os';

export function startWorkerHeartbeat(serviceName: string, queueName: string, intervalMs = 30000) {
  const pool = getPool();
  const workerId = `${serviceName}-${os.hostname()}-${process.pid}`;

  const sendHeartbeat = async () => {
    try {
      await pool.query(
        `INSERT INTO system_worker_heartbeats (worker_id, service_name, queue_name, hostname, last_heartbeat_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (worker_id) DO UPDATE SET
           last_heartbeat_at = NOW(),
           queue_name = EXCLUDED.queue_name`,
        [workerId, serviceName, queueName, os.hostname()]
      );
    } catch (err) {
      console.error('[worker-heartbeat] Failed to publish heartbeat to database:', err);
    }
  };

  // Immediate initial heartbeat
  sendHeartbeat();
  const timer = setInterval(sendHeartbeat, intervalMs);

  process.on('SIGTERM', async () => {
    clearInterval(timer);
    try {
      await pool.query(`DELETE FROM system_worker_heartbeats WHERE worker_id = $1`, [workerId]);
    } catch {}
  });
}
```

### 6. Prometheus OpenMetrics Scraping Endpoint (`apps/dashboard/app/api/health/metrics/route.ts`)
```typescript
import { NextResponse } from 'next/server';
import { getDbPool } from '@/lib/db';

export async function GET(request: Request) {
  // Protect metrics endpoint with bearer token
  const auth = request.headers.get('authorization');
  if (process.env.METRICS_TOKEN && auth !== `Bearer ${process.env.METRICS_TOKEN}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const pool = getDbPool();
  const mem = process.memoryUsage();

  const metrics = [
    '# HELP darex_db_pool_connections Current connection count in PostgreSQL pool',
    '# TYPE darex_db_pool_connections gauge',
    `darex_db_pool_connections{state="total"} ${pool.totalCount}`,
    `darex_db_pool_connections{state="idle"} ${pool.idleCount}`,
    `darex_db_pool_connections{state="waiting"} ${pool.waitingCount}`,
    '',
    '# HELP darex_node_memory_bytes Node.js process memory usage',
    '# TYPE darex_node_memory_bytes gauge',
    `darex_node_memory_bytes{type="heap_used"} ${mem.heapUsed}`,
    `darex_node_memory_bytes{type="heap_total"} ${mem.heapTotal}`,
    `darex_node_memory_bytes{type="rss"} ${mem.rss}`,
    '',
    '# HELP darex_process_uptime_seconds Process uptime in seconds',
    '# TYPE darex_process_uptime_seconds counter',
    `darex_process_uptime_seconds ${Math.floor(process.uptime())}`,
  ].join('\n');

  return new Response(metrics, {
    headers: {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Cache-Control': 'no-cache',
    }
  });
}
```

---

## Fix priority

- **P0**: Patch `pool.connect` globally to wrap every database client checkout with `wrapClientRelease` so direct pool queries cannot leave poisoned RLS tenant contexts.
- **P0**: Implement `/api/health/ready` checking Postgres, Redis, LiteLLM, and DB pool waiting count to prevent black-hole traffic routing.
- **P0**: Implement Temporal worker heartbeats to detect crashed or stalled automation workers.
- **P1**: Add in-memory 5-second caching on `/api/health/ready` to avoid pool starvation from aggressive load balancer probes.
- **P1**: Deploy authenticated `/api/health/diagnostics` endpoint for administrative troubleshooting.
- **P2**: Deploy `SystemDegradationBanner` in the UI to notify users when non-critical services are degraded.
- **P2**: Instrument Node.js runtime heap and event loop lag telemetry.
