/**
 * Activities for PlanExecute / OwnerBriefing / StaleChase / Nurture (WS-17).
 * Each activity takes orgId from verified workflow input — never from LLM output.
 * Pooled clients are released before any LLM or provider call.
 */

import { ApplicationFailure } from '@temporalio/activity';
import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { Pool, PoolClient } from 'pg';
import { executeAutonomousToolAction } from '../tool-executor.js';
import { resolveMetrics } from '../tools/metrics.js';
import { withOrgScopedClient } from '../tools/shared.js';
import {
  planExecuteAllowlist,
  stageSteps,
  wireDependencies,
  type PlanStepLike,
} from '../plan-steps.js';
import {
  defaultQuietHours,
  hoursUntilQuietEnd,
  isQuietHour,
  type NurtureCancelReason,
} from '../quiet-hours.js';
import type { NurtureTick } from '../quiet-hours.js';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'darex_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'darex',
});

async function withOrgClient<T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    return await fn(client);
  } finally {
    try {
      await client.query('RESET app.current_org_id');
    } catch {
      // always release
    }
    client.release();
  }
}

async function readIdempotent<T>(orgId: string, key: string | undefined): Promise<T | null> {
  if (!key) return null;
  return withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT result FROM idempotency_keys WHERE key = $1 AND org_id = $2 AND expires_at > NOW()`,
      [key, orgId]
    );
    if (res.rows.length === 0) return null;
    return (res.rows[0].result as T) ?? null;
  });
}

async function writeIdempotent(orgId: string, key: string | undefined, result: unknown): Promise<void> {
  if (!key) return;
  await withOrgClient(orgId, async (client) => {
    await client.query(
      `INSERT INTO idempotency_keys (key, org_id, result, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
       ON CONFLICT (key) DO UPDATE SET result = EXCLUDED.result, expires_at = EXCLUDED.expires_at`,
      [key, orgId, JSON.stringify(result)]
    );
  });
}

/**
 * Atomically claim a key before an irreversible side effect (send/pay/sign) runs,
 * closing the crash window that a read-then-act-then-write idempotency check leaves
 * open: if the process dies after the external call succeeds but before writeIdempotent,
 * a Temporal retry must not re-run the side effect. `result IS NULL` marks an in-flight
 * claim; a real completed result always has a status field.
 */
async function claimIdempotent<T>(
  orgId: string,
  key: string | undefined
): Promise<{ claimed: boolean; cached: T | null }> {
  if (!key) return { claimed: true, cached: null };
  return withOrgClient(orgId, async (client) => {
    const inserted = await client.query(
      `INSERT INTO idempotency_keys (key, org_id, result, expires_at)
       VALUES ($1, $2, NULL, NOW() + INTERVAL '24 hours')
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, orgId]
    );
    if (inserted.rows.length > 0) return { claimed: true, cached: null };

    const existing = await client.query(
      `SELECT result FROM idempotency_keys WHERE key = $1 AND org_id = $2 AND expires_at > NOW()`,
      [key, orgId]
    );
    if (existing.rows.length === 0 || existing.rows[0].result === null) {
      return { claimed: false, cached: null };
    }
    return { claimed: false, cached: existing.rows[0].result as T };
  });
}

function sideEffectKey(orgId: string, activityName: string, businessKey: string): string {
  return `${orgId}:${activityName}:${businessKey}`;
}

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

function zonedHour(at: Date, timeZone: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: timeZone || 'UTC',
    });
    return parseInt(fmt.format(at), 10);
  } catch {
    return at.getUTCHours();
  }
}

function msUntilHour(at: Date, timeZone: string, hour: number): number {
  const current = zonedHour(at, timeZone);
  let ahead = hour - current;
  if (ahead <= 0) ahead += 24;
  return ahead * 60 * 60 * 1000;
}

function redisTarget(): { host: string; port: number; password: string; tls: boolean } | null {
  const configured = process.env.REDIS_URL?.trim() || '';
  if (!configured || /langfuse-redis/i.test(configured)) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') return null;
    return {
      host: url.hostname || '127.0.0.1',
      port: url.port ? Number(url.port) : 6379,
      password: decodeURIComponent(url.password || ''),
      tls: url.protocol === 'rediss:',
    };
  } catch {
    return null;
  }
}

function encodeRedis(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const data = Buffer.from(arg, 'utf8');
    parts.push(Buffer.from(`$${data.length}\r\n`), data, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

async function publishOrgEvent(orgId: string, type: string, extra: Record<string, unknown>): Promise<void> {
  const target = redisTarget();
  if (!target) return;
  const payload = JSON.stringify({ type, orgId, ts: Date.now(), ...extra });
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    let socket: Socket;
    try {
      socket = target.tls
        ? tlsConnect({ host: target.host, port: target.port, servername: target.host })
        : createConnection({ host: target.host, port: target.port });
    } catch {
      done();
      return;
    }
    const timer = setTimeout(() => {
      socket.destroy();
      done();
    }, 3000);
    socket.once('error', () => {
      clearTimeout(timer);
      done();
    });
    socket.once('connect', () => {
      const cmds: string[][] = [];
      if (target.password) cmds.push(['AUTH', target.password]);
      cmds.push(['PUBLISH', `org:${orgId}`, payload]);
      socket.write(Buffer.concat(cmds.map(encodeRedis)));
      socket.end();
    });
    socket.once('close', () => {
      clearTimeout(timer);
      done();
    });
  });
}

export type LoadedPlanStage = { i: number; s: PlanStepLike };

export async function loadApprovedPlanActivity(params: {
  orgId: string;
  planId: string;
  businessKey: string;
}): Promise<{
  steps: PlanStepLike[];
  stages: LoadedPlanStage[][];
  planTools: string[];
  enabledCount: number;
  status: string;
}> {
  const orgId = requireOrgId(params.orgId);
  const row = await withOrgClient(orgId, async (client) => {
    const res = await client.query(`SELECT steps, status FROM agent_plans WHERE id = $1 AND org_id = $2`, [
      params.planId,
      orgId,
    ]);
    return res.rows[0] as { steps: unknown; status: string } | undefined;
  });
  if (!row) {
    throw ApplicationFailure.nonRetryable('Plan not found', 'InvalidArgumentError');
  }
  const steps: PlanStepLike[] = Array.isArray(row.steps) ? row.steps : [];
  return {
    steps,
    stages: stageSteps(steps),
    planTools: planExecuteAllowlist(steps),
    enabledCount: steps.filter((s) => s.enabled !== false).length,
    status: row.status,
  };
}

export async function updateAgentPlanActivity(params: {
  orgId: string;
  planId: string;
  status?: string;
  currentStep?: number;
  businessKey: string;
}): Promise<{ planId: string; status?: string }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'updateAgentPlan', params.businessKey);
  const cached = await readIdempotent<{ planId: string; status?: string }>(orgId, key);
  if (cached?.planId) return cached;

  const saved = await withOrgClient(orgId, async (client) => {
    const sets: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [];
    if (params.status) {
      values.push(params.status);
      sets.push(`status = $${values.length}`);
    }
    if (params.currentStep !== undefined) {
      values.push(params.currentStep);
      sets.push(`current_step = $${values.length}`);
    }
    values.push(params.planId, orgId);
    await client.query(
      `UPDATE agent_plans SET ${sets.join(', ')} WHERE id = $${values.length - 1} AND org_id = $${values.length}`,
      values
    );
    return { planId: params.planId, status: params.status };
  });
  await writeIdempotent(orgId, key, saved);
  return saved;
}

export async function executePlanStepActivity(params: {
  orgId: string;
  planId: string;
  stepIndex: number;
  step: PlanStepLike;
  previousResults: Array<Record<string, unknown>>;
  toolAllowlist: string[];
  businessKey: string;
}): Promise<{ status: string; message: string; data: unknown }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'executePlanStep', params.businessKey);
  const claim = await claimIdempotent<{ status: string; message: string; data: unknown }>(orgId, key);
  if (claim.cached?.status) return claim.cached;
  if (!claim.claimed) {
    return {
      status: 'error',
      message: 'Duplicate execution blocked: a previous attempt for this step is unresolved. Manual review required before retrying.',
      data: null,
    };
  }

  try {
    const payload = wireDependencies(params.step, params.previousResults);
    const result = await executeAutonomousToolAction({
      tool: String(params.step.tool || ''),
      action: String(params.step.action || ''),
      payload,
      orgId,
      toolAllowlist: params.toolAllowlist,
    });
    const saved = { status: result.status, message: result.message, data: result.data };
    await writeIdempotent(orgId, key, saved);
    await publishOrgEvent(orgId, 'plan.step', {
      planId: params.planId,
      stepIndex: params.stepIndex,
      status: result.status,
      message: String(result.message || '').slice(0, 200),
    });
    return saved;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const saved = { status: 'error', message, data: null as unknown };
    await writeIdempotent(orgId, key, saved);
    return saved;
  }
}

const BRIEFING_METRIC_IDS = [
  'core.inquiries_unworked',
  'core.conversations_open',
  'core.needs_attention',
  'core.work_items_open',
  'core.messages_inbound',
  'core.revenue_collected_7d',
];

export async function queryBriefingMetricsActivity(params: {
  orgId: string;
  businessKey: string;
}): Promise<{
  points: Array<{ metricId: string; value: number; from: string; to: string }>;
  gaps: string[];
}> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'queryBriefingMetrics', params.businessKey);
  const cached = await readIdempotent<{
    points: Array<{ metricId: string; value: number; from: string; to: string }>;
    gaps: string[];
  }>(orgId, key);
  if (cached?.points) return cached;

  const { hits, gaps } = resolveMetrics(BRIEFING_METRIC_IDS);
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const points: Array<{ metricId: string; value: number; from: string; to: string }> = [];
  const runtimeGaps = [...gaps];

  const connected = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('connected','active')`,
      [orgId]
    );
    return new Set(res.rows.map((r) => String(r.channel_type || '').toLowerCase()));
  });

  await withOrgScopedClient(orgId, async (client) => {
    for (const metric of hits) {
      if (!metric.sql) {
        runtimeGaps.push(metric.id);
        continue;
      }
      if (metric.source === 'stripe' && !connected.has('stripe')) {
        runtimeGaps.push(`${metric.id}: stripe not connected`);
        continue;
      }
      try {
        const sql = metric.sql.trim().replace(/\$from\b/g, '$1').replace(/\$to\b/g, '$2');
        const res = await client.query(sql, [fromIso, toIso]);
        const raw = res.rows[0]?.value;
        const value = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '0'));
        if (!Number.isFinite(value)) {
          runtimeGaps.push(metric.id);
          continue;
        }
        points.push({ metricId: metric.id, value, from: fromIso, to: toIso });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        runtimeGaps.push(`${metric.id}: ${message.slice(0, 180)}`);
      }
    }
  });

  const result = { points, gaps: runtimeGaps };
  await writeIdempotent(orgId, key, result);
  return result;
}

export async function listNeedsAttentionActivity(params: {
  orgId: string;
  businessKey: string;
}): Promise<{ count: number; conversationIds: string[] }> {
  const orgId = requireOrgId(params.orgId);
  const saved = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT id FROM conversations
       WHERE org_id = $1 AND status = 'needs_attention'
       ORDER BY updated_at DESC
       LIMIT 25`,
      [orgId]
    );
    return {
      count: res.rows.length,
      conversationIds: res.rows.map((r) => String(r.id)),
    };
  });
  return saved;
}

async function litellmNarrative(aggregatesJson: string): Promise<string | null> {
  const isProd = process.env.NODE_ENV === 'production';
  const rawBase = process.env.LITELLM_BASE_URL || (isProd ? '' : 'http://localhost:4000/v1');
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  const model = process.env.LITELLM_MODEL || 'atomic-agent';
  if (!rawBase || !apiKey) return null;
  const baseUrl = rawBase.replace(/\/$/, '');
  const url = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 280,
        temperature: 0,
        reasoning: { enabled: false },
        messages: [
          {
            role: 'system',
            content: [
              'You write a short owner morning briefing from pre-aggregated KPI numbers only.',
              'Never invent counts. Never ask for raw messages or scan inboxes.',
              'If a metric is listed in gaps, say the connector or table is missing — do not guess.',
              'Reply with 3-6 sentences of plain prose, no JSON.',
            ].join(' '),
          },
          { role: 'user', content: aggregatesJson },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = (data?.choices?.[0]?.message?.content || '').trim();
    return content || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function templateNarrative(
  points: Array<{ metricId: string; value: number }>,
  gaps: string[],
  needsAttentionCount: number
): string {
  const byId = new Map(points.map((p) => [p.metricId, p.value]));
  const unworked = byId.get('core.inquiries_unworked') ?? 0;
  const open = byId.get('core.conversations_open') ?? 0;
  const attention = byId.get('core.needs_attention') ?? needsAttentionCount;
  const lines = [
    `Morning briefing: ${unworked} unworked inquiries, ${open} open conversations, ${attention} threads need attention.`,
  ];
  const inbound = byId.get('core.messages_inbound');
  if (typeof inbound === 'number') lines.push(`Inbound messages in the last 7 days: ${inbound}.`);
  const revenue = byId.get('core.revenue_collected_7d');
  if (typeof revenue === 'number') lines.push(`Revenue collected (7d, Stripe logs): ${revenue}.`);
  if (gaps.length > 0) lines.push(`Honest gaps: ${gaps.slice(0, 4).join('; ')}.`);
  return lines.join(' ');
}

export async function narrateBriefingActivity(params: {
  orgId: string;
  points: Array<{ metricId: string; value: number; from?: string; to?: string }>;
  gaps: string[];
  needsAttentionCount: number;
  businessKey: string;
}): Promise<{ narrative: string; source: 'litellm' | 'template' }> {
  requireOrgId(params.orgId);
  const aggregates = JSON.stringify({
    points: params.points.map((p) => ({ metricId: p.metricId, value: p.value })),
    gaps: params.gaps,
    needsAttentionCount: params.needsAttentionCount,
  });
  const modeled = await litellmNarrative(aggregates);
  if (modeled) return { narrative: modeled, source: 'litellm' };
  return {
    narrative: templateNarrative(params.points, params.gaps, params.needsAttentionCount),
    source: 'template',
  };
}

export async function persistBriefingActivity(params: {
  orgId: string;
  points: Array<{ metricId: string; value: number; from?: string; to?: string }>;
  gaps: string[];
  narrative: string;
  needsAttentionCount: number;
  businessKey: string;
}): Promise<{ generatedAt: string; logId: string }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'persistBriefing', params.businessKey);
  const cached = await readIdempotent<{ generatedAt: string; logId: string }>(orgId, key);
  if (cached?.logId) return cached;

  const generatedAt = new Date().toISOString();
  const payload = {
    kind: 'owner_briefing',
    points: params.points,
    gaps: params.gaps,
    narrative: params.narrative,
    needsAttentionCount: params.needsAttentionCount,
    generatedAt,
  };
  const saved = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, 'dashboard', 'OWNER_BRIEFING', 'success', 200, $2, $3)
       RETURNING id`,
      [orgId, params.narrative.slice(0, 500), JSON.stringify(payload)]
    );
    return { generatedAt, logId: String(res.rows[0].id) };
  });
  await writeIdempotent(orgId, key, saved);
  await publishOrgEvent(orgId, 'owner.briefing', {
    message: params.narrative.slice(0, 200),
    needsAttention: params.needsAttentionCount,
  });
  return saved;
}

export async function msUntilNextHourActivity(params: {
  timeZone: string;
  hour: number;
}): Promise<number> {
  return msUntilHour(new Date(), params.timeZone || 'UTC', params.hour);
}

export type StaleConversationRow = {
  conversationId: string;
  workItemId?: string;
  channel: string;
  contactId?: string;
  hasOutboundInSla: boolean;
  doNotContact: boolean;
};

export async function listStaleConversationsActivity(params: {
  orgId: string;
  slaHours: number;
  limit: number;
  businessKey: string;
}): Promise<{ conversations: StaleConversationRow[]; gaps: string[] }> {
  const orgId = requireOrgId(params.orgId);
  const sla = Math.max(1, params.slaHours || 2);
  const limit = Math.min(Math.max(1, params.limit || 10), 10);
  const gaps: string[] = [];

  const conversations = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT c.id AS conversation_id,
              c.channel_id,
              c.contact_id,
              c.metadata,
              c.status,
              w.id AS work_item_id,
              ch.channel_type,
              EXISTS (
                SELECT 1 FROM messages outbound
                WHERE outbound.org_id = c.org_id
                  AND outbound.conversation_id = c.id
                  AND outbound.role IN ('assistant', 'agent')
                  AND outbound.created_at <= (
                    SELECT MIN(inbound.created_at) + ($2::int * INTERVAL '1 hour')
                    FROM messages inbound
                    WHERE inbound.org_id = c.org_id
                      AND inbound.conversation_id = c.id
                      AND inbound.role IN ('user', 'customer')
                  )
              ) AS has_outbound_in_sla
       FROM conversations c
       LEFT JOIN work_items w ON w.org_id = c.org_id AND w.conversation_id = c.id
       LEFT JOIN channels ch ON ch.id = c.channel_id AND ch.org_id = c.org_id
       WHERE c.org_id = $1
         AND c.status IN ('open', 'needs_attention')
         AND EXISTS (
           SELECT 1 FROM messages inbound
           WHERE inbound.org_id = c.org_id
             AND inbound.conversation_id = c.id
             AND inbound.role IN ('user', 'customer')
         )
         AND NOT EXISTS (
           SELECT 1 FROM messages outbound
           WHERE outbound.org_id = c.org_id
             AND outbound.conversation_id = c.id
             AND outbound.role IN ('assistant', 'agent')
             AND outbound.created_at <= (
               SELECT MIN(inbound.created_at) + ($2::int * INTERVAL '1 hour')
               FROM messages inbound
               WHERE inbound.org_id = c.org_id
                 AND inbound.conversation_id = c.id
                 AND inbound.role IN ('user', 'customer')
             )
         )
       ORDER BY c.updated_at ASC
       LIMIT $3`,
      [orgId, sla, limit]
    );
    return res.rows.map((row) => {
      const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      const doNotContact = Boolean(
        (metadata as { doNotContact?: boolean; do_not_contact?: boolean }).doNotContact ||
          (metadata as { do_not_contact?: boolean }).do_not_contact
      );
      return {
        conversationId: String(row.conversation_id),
        workItemId: row.work_item_id ? String(row.work_item_id) : undefined,
        channel: String(row.channel_type || 'unknown').toLowerCase(),
        contactId: row.contact_id ? String(row.contact_id) : undefined,
        hasOutboundInSla: Boolean(row.has_outbound_in_sla),
        doNotContact,
      };
    });
  });

  return { conversations, gaps };
}

export async function markStaleNeedsAttentionActivity(params: {
  orgId: string;
  conversationId: string;
  workItemId?: string;
  reason: string;
  businessKey: string;
}): Promise<{ conversationId: string; status: 'needs_attention' }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'markStaleNeedsAttention', params.businessKey);
  const cached = await readIdempotent<{ conversationId: string; status: 'needs_attention' }>(orgId, key);
  if (cached?.conversationId) return cached;

  const saved = await withOrgClient(orgId, async (client) => {
    await client.query(
      `UPDATE conversations SET status = 'needs_attention', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
      [params.conversationId, orgId]
    );
    if (params.workItemId) {
      await client.query(
        `UPDATE work_items SET status = 'needs_attention' WHERE id = $1 AND org_id = $2`,
        [params.workItemId, orgId]
      );
    }
    await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, 'agent', 'STALE_CHASE', 'error', 500, $2, $3)`,
      [
        orgId,
        params.reason.slice(0, 500),
        JSON.stringify({ conversationId: params.conversationId, reason: params.reason }),
      ]
    );
    return { conversationId: params.conversationId, status: 'needs_attention' as const };
  });
  await writeIdempotent(orgId, key, saved);
  await publishOrgEvent(orgId, 'conversation_updated', { conversationId: params.conversationId });
  return saved;
}

export type NurtureGateAction = 'send' | 'cancel' | 'sleep_quiet';

export async function nurtureGateActivity(params: {
  orgId: string;
  conversationId: string;
  startedAt: number;
  timeZone: string;
  emergencyPolicy: boolean;
  businessKey: string;
}): Promise<{
  action: NurtureGateAction;
  reason?: NurtureCancelReason | string;
  waitMs: number;
  contactId?: string;
}> {
  const orgId = requireOrgId(params.orgId);
  const row = await withOrgClient(orgId, async (client) => {
    const conv = await client.query(
      `SELECT status, contact_id, metadata FROM conversations WHERE id = $1 AND org_id = $2`,
      [params.conversationId, orgId]
    );
    const inbound = await client.query(
      `SELECT COUNT(*)::int AS n FROM messages
       WHERE org_id = $1 AND conversation_id = $2
         AND role IN ('user', 'customer')
         AND created_at > to_timestamp($3 / 1000.0)`,
      [orgId, params.conversationId, params.startedAt]
    );
    return {
      conv: conv.rows[0] as { status?: string; contact_id?: string; metadata?: Record<string, unknown> } | undefined,
      inboundAfter: Number(inbound.rows[0]?.n || 0),
    };
  });

  if (!row.conv) {
    return { action: 'cancel', reason: 'inbound', waitMs: 0 };
  }
  const metadata = row.conv.metadata && typeof row.conv.metadata === 'object' ? row.conv.metadata : {};
  const doNotContact = Boolean(metadata.doNotContact || metadata.do_not_contact);
  const takeover = Boolean(metadata.humanTakeover || metadata.human_takeover || metadata.takeover);
  const status = String(row.conv.status || '');

  if (doNotContact) return { action: 'cancel', reason: 'do_not_contact', waitMs: 0 };
  if (takeover || status === 'resolved' || status === 'closed' || status === 'cancelled') {
    return { action: 'cancel', reason: 'takeover', waitMs: 0 };
  }
  if (row.inboundAfter > 0) return { action: 'cancel', reason: 'inbound', waitMs: 0 };

  if (!params.emergencyPolicy) {
    const window = defaultQuietHours(params.timeZone || 'UTC');
    const hour = zonedHour(new Date(), window.timeZone);
    if (isQuietHour(hour, window)) {
      const hours = hoursUntilQuietEnd(hour, window);
      return {
        action: 'sleep_quiet',
        reason: 'quiet_hours',
        waitMs: Math.max(hours, 1) * 60 * 60 * 1000,
        contactId: row.conv.contact_id,
      };
    }
  }

  return { action: 'send', waitMs: 0, contactId: row.conv.contact_id };
}

export async function sendNurtureMessageActivity(params: {
  orgId: string;
  conversationId: string;
  contactId?: string;
  channel: 'whatsapp' | 'email';
  tick: NurtureTick;
  template?: string;
  businessKey: string;
}): Promise<{ sent: boolean; status: string; message: string }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'sendNurtureMessage', params.businessKey);
  const claim = await claimIdempotent<{ sent: boolean; status: string; message: string }>(orgId, key);
  if (claim.cached && typeof claim.cached.sent === 'boolean') return claim.cached;
  if (!claim.claimed) {
    return {
      sent: false,
      status: 'error',
      message: 'Duplicate execution blocked: a previous attempt for this message is unresolved.',
    };
  }

  const body =
    params.template ||
    `Following up (${params.tick}). Just checking whether you still need help — reply anytime and we will pick this up.`;

  let result: { sent: boolean; status: string; message: string };
  switch (params.channel) {
    case 'whatsapp': {
      const exec = await executeAutonomousToolAction({
        tool: 'whatsapp',
        action: 'send_whatsapp_message',
        payload: { phone: params.contactId, contactId: params.contactId, message: body },
        orgId,
        toolAllowlist: ['whatsapp'],
      });
      result = {
        sent: exec.status === 'executed',
        status: exec.status,
        message: exec.message,
      };
      break;
    }
    case 'email': {
      const exec = await executeAutonomousToolAction({
        tool: 'gmail',
        action: 'send_email',
        payload: { to: params.contactId, body, subject: `Follow-up (${params.tick})` },
        orgId,
        toolAllowlist: ['gmail'],
      });
      result = {
        sent: exec.status === 'executed',
        status: exec.status,
        message: exec.message,
      };
      break;
    }
    default: {
      const _exhaustive: never = params.channel;
      result = { sent: false, status: 'error', message: `Unsupported channel: ${_exhaustive}` };
      break;
    }
  }

  await writeIdempotent(orgId, key, result);
  if (result.sent) {
    await withOrgClient(orgId, async (client) => {
      await client.query(
        `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
         VALUES ($1, $2, 'assistant', $3, NOW())`,
        [orgId, params.conversationId, body]
      );
    });
  }
  return result;
}

export type InsightMetricActivityStatus = 'ok' | 'notConnected' | 'error';

export async function queryInsightMetricActivity(params: {
  orgId: string;
  metricId: string;
  businessKey: string;
}): Promise<{
  metricId: string;
  value: number | null;
  from: string;
  to: string;
  status: InsightMetricActivityStatus;
  message: string;
  gaps: string[];
}> {
  const orgId = requireOrgId(params.orgId);
  const { hits, gaps } = resolveMetrics([params.metricId]);
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const metric = hits[0];
  if (!metric || !metric.sql) {
    return {
      metricId: params.metricId,
      value: null,
      from: fromIso,
      to: toIso,
      status: 'error',
      message: gaps[0] ? `Unknown metric: ${gaps[0]}` : `Metric ${params.metricId} has no SQL`,
      gaps,
    };
  }

  const connected = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('connected','active')`,
      [orgId]
    );
    return new Set(res.rows.map((r) => String(r.channel_type || '').toLowerCase()));
  });

  if (metric.source === 'stripe' && !connected.has('stripe')) {
    return {
      metricId: metric.id,
      value: null,
      from: fromIso,
      to: toIso,
      status: 'notConnected',
      message: 'stripe not connected — this action is not counted as success',
      gaps: [`${metric.id}: stripe not connected`],
    };
  }

  try {
    const value = await withOrgScopedClient(orgId, async (client) => {
      const sql = metric.sql!.trim().replace(/\$from\b/g, '$1').replace(/\$to\b/g, '$2');
      const res = await client.query(sql, [fromIso, toIso]);
      const raw = res.rows[0]?.value;
      const parsed = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '0'));
      return Number.isFinite(parsed) ? parsed : null;
    });
    if (value === null) {
      return {
        metricId: metric.id,
        value: null,
        from: fromIso,
        to: toIso,
        status: 'error',
        message: `Metric ${metric.id} returned a non-numeric value`,
        gaps: [metric.id],
      };
    }
    return {
      metricId: metric.id,
      value,
      from: fromIso,
      to: toIso,
      status: 'ok',
      message: `${metric.id} = ${value}`,
      gaps: [],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      metricId: metric.id,
      value: null,
      from: fromIso,
      to: toIso,
      status: 'error',
      message: message.slice(0, 180),
      gaps: [`${metric.id}: ${message.slice(0, 180)}`],
    };
  }
}

export async function persistInsightActionActivity(params: {
  orgId: string;
  metricId: string;
  namedWorkflow: string;
  childWorkflowId: string | null;
  success: boolean;
  status: string;
  metricValue: number | null;
  message: string;
  businessKey: string;
}): Promise<{ logId: string }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'persistInsightAction', params.businessKey);
  const cached = await readIdempotent<{ logId: string }>(orgId, key);
  if (cached?.logId) return cached;

  const payload = {
    kind: 'insight_action',
    metricId: params.metricId,
    namedWorkflow: params.namedWorkflow,
    childWorkflowId: params.childWorkflowId,
    success: params.success,
    status: params.status,
    metricValue: params.metricValue,
    message: params.message,
  };
  const logStatus = params.success ? 'success' : 'error';
  const saved = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
       VALUES ($1, 'dashboard', 'INSIGHT_ACTION', $2, $3, $4, $5)
       RETURNING id`,
      [
        orgId,
        logStatus,
        params.success ? 200 : 500,
        params.message.slice(0, 500),
        JSON.stringify(payload),
      ]
    );
    return { logId: String(res.rows[0].id) };
  });
  await writeIdempotent(orgId, key, saved);
  await publishOrgEvent(orgId, 'insight.action', {
    metricId: params.metricId,
    namedWorkflow: params.namedWorkflow,
    success: params.success,
    childWorkflowId: params.childWorkflowId,
  });
  return saved;
}
