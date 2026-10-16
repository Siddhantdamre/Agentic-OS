import { NextResponse } from 'next/server';
import { createConnection } from 'node:net';
import { healthProbePool, pool } from '@/lib/db';
import { collectRuntimeTelemetry } from '@/lib/runtime-telemetry';
import { CheckResult, evaluateReadiness } from '@/lib/health-readiness';

export const dynamic = 'force-dynamic';

const PROBE_TIMEOUT_MS = 800;
const CACHE_TTL_MS = 5000;
const POOL_WAITING_WARN = 5;

type ReadyPayload = {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: Record<string, CheckResult>;
  runtime: Awaited<ReturnType<typeof collectRuntimeTelemetry>>;
};

let cached: { at: number; payload: ReadyPayload; httpStatus: number } | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function checkPostgres(): Promise<CheckResult> {
  const start = Date.now();
  try {
    // Dedicated max:1 pool. Never sets a tenant GUC and never reads tenant tables.
    await withTimeout(healthProbePool.query('SELECT 1'), PROBE_TIMEOUT_MS, 'postgres');
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch {
    return { status: 'error', latencyMs: Date.now() - start, detail: 'Database unreachable' };
  }
}

function checkDbPool(): CheckResult {
  const waitingCount =
    typeof pool.waitingCount === 'number' ? pool.waitingCount : undefined;
  const totalCount = typeof pool.totalCount === 'number' ? pool.totalCount : undefined;
  const idleCount = typeof pool.idleCount === 'number' ? pool.idleCount : undefined;

  if (waitingCount === undefined) {
    return { status: 'skipped', detail: 'Pool waiting count not exposed' };
  }

  if (waitingCount >= POOL_WAITING_WARN) {
    return {
      status: 'error',
      waitingCount,
      totalCount,
      idleCount,
      detail: `Pool pressure: ${waitingCount} waiting`,
    };
  }

  return { status: 'ok', waitingCount, totalCount, idleCount };
}

async function redisPing(urlString: string): Promise<void> {
  const url = new URL(urlString);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must be redis:// or rediss://');
  }
  const host = url.hostname || '127.0.0.1';
  const port = url.port ? Number(url.port) : 6379;
  const password = decodeURIComponent(url.password || '');

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.on('timeout', () => finish(new Error('Redis ping timeout')));
    socket.on('error', (err) => finish(err));
    socket.on('connect', () => {
      const cmds: string[] = [];
      if (password) {
        cmds.push(`*2\r\n$4\r\nAUTH\r\n$${Buffer.byteLength(password)}\r\n${password}\r\n`);
      }
      cmds.push('*1\r\n$4\r\nPING\r\n');
      socket.write(cmds.join(''));
    });
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('+PONG') || /\$4\r\nPONG/i.test(buf)) {
        finish();
      } else if (buf.includes('-ERR') || buf.includes('-NOAUTH')) {
        finish(new Error('Redis auth/ping failed'));
      }
    });
  });
}

async function checkRedis(): Promise<CheckResult> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    return { status: 'not_configured', detail: 'REDIS_URL unset' };
  }
  if (/langfuse-redis/i.test(redisUrl)) {
    return { status: 'error', detail: 'REDIS_URL points at langfuse-redis' };
  }
  const start = Date.now();
  try {
    await withTimeout(redisPing(redisUrl), PROBE_TIMEOUT_MS, 'redis');
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch {
    return { status: 'error', latencyMs: Date.now() - start, detail: 'Redis unreachable' };
  }
}

async function checkTemporal(): Promise<CheckResult> {
  const address = process.env.TEMPORAL_ADDRESS?.trim();
  if (!address) {
    return { status: 'not_configured', detail: 'TEMPORAL_ADDRESS unset' };
  }
  const start = Date.now();
  try {
    // Lightweight TCP reachability — avoid holding a Temporal Client in the health path.
    let host = '127.0.0.1';
    let port = 7233;
    if (address.includes('://')) {
      const u = new URL(address);
      host = u.hostname || host;
      port = Number(u.port || port);
    } else {
      const [h, p] = address.split(':');
      host = h || host;
      port = Number(p || port);
    }
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host, port });
        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          if (err) reject(err);
          else resolve();
        };
        socket.setTimeout(PROBE_TIMEOUT_MS);
        socket.on('connect', () => finish());
        socket.on('timeout', () => finish(new Error('Temporal connect timeout')));
        socket.on('error', (err) => finish(err));
      }),
      PROBE_TIMEOUT_MS,
      'temporal'
    );
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch {
    return { status: 'error', latencyMs: Date.now() - start, detail: 'Temporal unreachable' };
  }
}

async function tcpReachable(host: string, port: number, label: string): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host, port });
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve();
      };
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.on('connect', () => finish());
      socket.on('timeout', () => finish(new Error(`${label} connect timeout`)));
      socket.on('error', (err) => finish(err));
    }),
    PROBE_TIMEOUT_MS,
    label
  );
}

function hostPortFromUrl(raw: string, fallbackPort: number): { host: string; port: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const u = new URL(withScheme);
    const host = u.hostname;
    if (!host) return null;
    const port = u.port ? Number(u.port) : fallbackPort;
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host, port };
  } catch {
    return null;
  }
}

async function checkCognee(): Promise<CheckResult> {
  const base = process.env.COGNEE_URL?.trim() || '';
  if (!base) {
    return { status: 'not_configured', detail: 'COGNEE_URL unset' };
  }
  const start = Date.now();
  const root = base.replace(/\/$/, '');
  const headers: Record<string, string> = {};
  const apiKey = process.env.COGNEE_API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    let ok = false;
    for (const path of ['/health', '/docs']) {
      const res = await withTimeout(
        fetch(`${root}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
        PROBE_TIMEOUT_MS,
        'cognee'
      );
      if (res.ok) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      return { status: 'error', latencyMs: Date.now() - start, detail: 'Cognee unreachable' };
    }
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch {
    return { status: 'error', latencyMs: Date.now() - start, detail: 'Cognee unreachable' };
  }
}

async function checkHindsight(): Promise<CheckResult> {
  const base = process.env.HINDSIGHT_URL?.trim() || '';
  if (!base) {
    return { status: 'not_configured', detail: 'HINDSIGHT_URL unset' };
  }
  const start = Date.now();
  const headers: Record<string, string> = {};
  const apiKey = process.env.HINDSIGHT_API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const res = await withTimeout(
      fetch(`${base.replace(/\/$/, '')}/health`, { method: 'GET', headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
      PROBE_TIMEOUT_MS,
      'hindsight'
    );
    return res.ok
      ? { status: 'ok', latencyMs: Date.now() - start }
      : { status: 'error', latencyMs: Date.now() - start, detail: 'Hindsight unhealthy' };
  } catch {
    return { status: 'error', latencyMs: Date.now() - start, detail: 'Hindsight unreachable' };
  }
}

async function checkEvolution(): Promise<CheckResult> {
  // The QR WhatsApp gateway. Optional: only probed when the server is configured for it.
  const base = process.env.EVOLUTION_API_URL?.trim() || '';
  if (!base) return { status: 'not_configured', detail: 'EVOLUTION_API_URL unset' };
  const start = Date.now();
  try {
    const res = await withTimeout(
      fetch(`${base.replace(/\/$/, '')}/`, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
      PROBE_TIMEOUT_MS,
      'evolution'
    );
    return res.ok
      ? { status: 'ok', latencyMs: Date.now() - start }
      : { status: 'error', latencyMs: Date.now() - start, detail: 'Evolution unhealthy' };
  } catch {
    return { status: 'error', latencyMs: Date.now() - start, detail: 'Evolution unreachable' };
  }
}

async function checkMcpBridge(): Promise<CheckResult> {
  const raw = process.env.MCP_BRIDGE_URL?.trim() || '';
  if (!raw) {
    return { status: 'not_configured', detail: 'MCP_BRIDGE_URL unset' };
  }
  const target = hostPortFromUrl(raw, 8790);
  if (!target) {
    return { status: 'error', detail: 'MCP_BRIDGE_URL is not a host:port' };
  }
  const start = Date.now();
  try {
    await tcpReachable(target.host, target.port, 'mcp-bridge');
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch {
    return { status: 'error', latencyMs: Date.now() - start, detail: 'MCP bridge unreachable' };
  }
}

async function checkHttpDependency(envName: string, raw: string, label: string): Promise<CheckResult> {
  if (!raw.trim()) {
    return { status: 'not_configured', detail: `${envName} unset` };
  }
  const start = Date.now();
  const root = raw.trim().replace(/\/$/, '');
  try {
    const res = await withTimeout(
      fetch(root, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
      PROBE_TIMEOUT_MS,
      label
    );
    if (!res.ok) {
      return { status: 'error', latencyMs: Date.now() - start, detail: `${label} HTTP ${res.status}` };
    }
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch {
    return { status: 'error', latencyMs: Date.now() - start, detail: `${label} unreachable` };
  }
}

async function checkNango(): Promise<CheckResult> {
  const base = process.env.NANGO_HOST?.trim() || '';
  return checkHttpDependency('NANGO_HOST', base ? `${base.replace(/\/$/, '')}/health` : '', 'nango');
}

async function checkLangfuse(): Promise<CheckResult> {
  const base = process.env.LANGFUSE_HOST?.trim() || '';
  return checkHttpDependency('LANGFUSE_HOST', base ? `${base.replace(/\/$/, '')}/api/public/health` : '', 'langfuse');
}

async function checkSuperTokens(): Promise<CheckResult> {
  const base = process.env.SUPERTOKENS_CONNECTION_URI?.trim() || '';
  return checkHttpDependency('SUPERTOKENS_CONNECTION_URI', base ? `${base.replace(/\/$/, '')}/hello` : '', 'supertokens');
}

async function checkWorker(): Promise<CheckResult> {
  return checkHttpDependency('WORKER_HEALTH_URL', process.env.WORKER_HEALTH_URL?.trim() || '', 'worker');
}

async function checkLiteLLM(): Promise<CheckResult> {
  const base =
    process.env.LITELLM_BASE_URL?.trim() ||
    process.env.LITELLM_URL?.trim() ||
    '';
  if (!base) {
    return { status: 'not_configured', detail: 'LITELLM_BASE_URL unset' };
  }
  const start = Date.now();
  try {
    // LiteLLM's /health requires a bearer key and returns 401 without one.
    // /health/readiness is the unauthenticated probe the compose healthcheck uses.
    const healthUrl = base.replace(/\/v1\/?$/, '').replace(/\/$/, '') + '/health/readiness';
    const apiKey = process.env.LITELLM_API_KEY?.trim() || process.env.LITELLM_MASTER_KEY?.trim() || '';
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await withTimeout(
      fetch(healthUrl, { method: 'GET', headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
      PROBE_TIMEOUT_MS,
      'litellm'
    );
    if (!res.ok) {
      return {
        status: 'error',
        latencyMs: Date.now() - start,
        detail: `LiteLLM HTTP ${res.status}`,
      };
    }
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch {
    return { status: 'error', latencyMs: Date.now() - start, detail: 'LiteLLM unreachable' };
  }
}


export async function GET() {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return NextResponse.json(cached.payload, { status: cached.httpStatus });
  }

  const results = await Promise.allSettled([
    checkPostgres(),
    checkRedis(),
    checkTemporal(),
    checkLiteLLM(),
    checkCognee(),
    checkHindsight(),
    checkMcpBridge(),
    checkNango(),
    checkLangfuse(),
    checkSuperTokens(),
    checkWorker(),
    collectRuntimeTelemetry(),
    checkEvolution(),
  ]);

  const postgres = results[0].status === 'fulfilled' ? results[0].value : { status: 'error' as const, detail: 'probe failed' };
  const redis = results[1].status === 'fulfilled' ? results[1].value : { status: 'error' as const, detail: 'probe failed' };
  const temporal = results[2].status === 'fulfilled' ? results[2].value : { status: 'error' as const, detail: 'probe failed' };
  const litellm = results[3].status === 'fulfilled' ? results[3].value : { status: 'error' as const, detail: 'probe failed' };
  const cognee = results[4].status === 'fulfilled' ? results[4].value : { status: 'error' as const, detail: 'probe failed' };
  const hindsight = results[5].status === 'fulfilled' ? results[5].value : { status: 'error' as const, detail: 'probe failed' };
  const mcp_bridge = results[6].status === 'fulfilled' ? results[6].value : { status: 'error' as const, detail: 'probe failed' };
  const nango = results[7].status === 'fulfilled' ? results[7].value : { status: 'error' as const, detail: 'probe failed' };
  const langfuse = results[8].status === 'fulfilled' ? results[8].value : { status: 'error' as const, detail: 'probe failed' };
  const supertokens = results[9].status === 'fulfilled' ? results[9].value : { status: 'error' as const, detail: 'probe failed' };
  const worker = results[10].status === 'fulfilled' ? results[10].value : { status: 'error' as const, detail: 'probe failed' };
  const runtime = results[11].status === 'fulfilled' ? results[11].value : ({} as any);
  const evolution = results[12].status === 'fulfilled' ? results[12].value : { status: 'error' as const, detail: 'probe failed' };

  const db_pool = checkDbPool();

  const checks: Record<string, CheckResult> = {
    postgres,
    redis,
    temporal,
    litellm,
    cognee,
    hindsight,
    evolution,
    mcp_bridge,
    nango,
    langfuse,
    supertokens,
    worker,
    db_pool,
  };

  const { status, httpStatus } = evaluateReadiness(checks);

  const payload: ReadyPayload = {
    status,
    timestamp: new Date().toISOString(),
    checks,
    runtime,
  };

  cached = { at: now, payload, httpStatus };
  return NextResponse.json(payload, { status: httpStatus });
}
