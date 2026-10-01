/**
 * Worker-side billing meter refresh (BIZ-B01).
 *
 * Before this, `billing_meters` was only written when somebody opened
 * /billing, so the usage gate read stale rows and hard caps never tripped
 * for an org nobody looked at. BillingSweepWorkflow calls this for every
 * billable org on a fixed interval.
 *
 * Sources, all under org RLS:
 *   - whatsapp_conversations: conversations on the org's WhatsApp channel
 *   - seats: users in the org
 *   - llm_tokens: org_model_spend (written by recordModelSpend at the model
 *     boundary). The dashboard also writes this meter from Langfuse; the
 *     upsert keeps the larger of the two so neither source can lower a cap
 *     reading the other produced.
 */

import type { PoolClient } from 'pg';
import { withOrgClient, workerPool } from '../db.js';

export const METER_WINDOW_DAYS = 7;

export type MeterCaps = {
  llmSoftUsd: number;
  llmHardUsd: number;
  whatsappSoft: number;
  whatsappHard: number;
  seatSoft: number;
  seatHard: number;
};

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Same env names and defaults as the dashboard's `meterCaps()`. */
export function meterCapsFromEnv(): MeterCaps {
  return {
    llmSoftUsd: envNumber('DAREX_METER_LLM_SOFT_USD', 50),
    llmHardUsd: envNumber('DAREX_METER_LLM_HARD_USD', 200),
    whatsappSoft: Math.floor(envNumber('DAREX_METER_WHATSAPP_SOFT', 500)),
    whatsappHard: Math.floor(envNumber('DAREX_METER_WHATSAPP_HARD', 2000)),
    seatSoft: Math.floor(envNumber('DAREX_METER_SEAT_SOFT', 5)),
    seatHard: Math.floor(envNumber('DAREX_METER_SEAT_HARD', 25)),
  };
}

export type MeterWindow = { from: Date; periodStart: string; periodEnd: string };

export function meterWindow(now: Date = new Date()): MeterWindow {
  const from = new Date(now.getTime() - METER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    from,
    periodStart: from.toISOString().slice(0, 10),
    periodEnd: now.toISOString().slice(0, 10),
  };
}

/** Cents → USD with 4dp so small spends are not rounded to zero. */
export function spendCentsToUsd(cents: number): number {
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  return Math.round(cents * 100) / 10000;
}

export type OrgMeterReading = {
  orgId: string;
  periodStart: string;
  periodEnd: string;
  whatsappConversations: number;
  seats: number;
  llmUsd: number;
  llmSpendAvailable: boolean;
};

type Queryable = Pick<PoolClient, 'query'>;

function isUndefinedTable(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

export async function readOrgMeterReading(
  client: Queryable,
  orgId: string,
  window: MeterWindow
): Promise<OrgMeterReading> {
  const wa = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id AND ch.org_id = c.org_id
      WHERE c.org_id = $1
        AND c.started_at >= $2
        AND (
          ch.channel_type = 'whatsapp'
          OR (ch.channel_type IS NULL AND COALESCE(c.metadata->>'channel', '') = 'whatsapp')
        )`,
    [orgId, window.from.toISOString()]
  );
  const seats = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM users WHERE org_id = $1`,
    [orgId]
  );

  let llmUsd = 0;
  let llmSpendAvailable = true;
  try {
    const spend = await client.query<{ cents: string | null }>(
      `SELECT COALESCE(SUM(spend_cents), 0)::text AS cents
         FROM org_model_spend
        WHERE org_id = $1 AND spend_date >= $2::date`,
      [orgId, window.periodStart]
    );
    llmUsd = spendCentsToUsd(Number(spend.rows[0]?.cents ?? 0));
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
    llmSpendAvailable = false;
  }

  return {
    orgId,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    whatsappConversations: parseInt(wa.rows[0]?.count || '0', 10) || 0,
    seats: parseInt(seats.rows[0]?.count || '0', 10) || 0,
    llmUsd,
    llmSpendAvailable,
  };
}

export type MeterUpsert = {
  kind: 'llm_tokens' | 'whatsapp_conversations' | 'seats';
  quantity: number;
  unit: string;
  soft: number | null;
  hard: number | null;
  source: 'model_spend' | 'conversations' | 'users';
  /** llm_tokens keeps the max of Langfuse and model-spend readings. */
  monotonic: boolean;
};

export function meterUpserts(reading: OrgMeterReading, caps: MeterCaps): MeterUpsert[] {
  const rows: MeterUpsert[] = [
    {
      kind: 'whatsapp_conversations',
      quantity: reading.whatsappConversations,
      unit: 'conversations',
      soft: caps.whatsappSoft || null,
      hard: caps.whatsappHard || null,
      source: 'conversations',
      monotonic: false,
    },
    {
      kind: 'seats',
      quantity: reading.seats,
      unit: 'seats',
      soft: caps.seatSoft || null,
      hard: caps.seatHard || null,
      source: 'users',
      monotonic: false,
    },
  ];
  if (reading.llmSpendAvailable) {
    rows.push({
      kind: 'llm_tokens',
      quantity: reading.llmUsd,
      unit: 'usd',
      soft: caps.llmSoftUsd || null,
      hard: caps.llmHardUsd || null,
      source: 'model_spend',
      monotonic: true,
    });
  }
  return rows;
}

export const METER_UPSERT_SQL = `INSERT INTO billing_meters (
     org_id, period_start, period_end, meter_kind, quantity, unit,
     soft_limit, hard_limit, source, truncated, updated_at
   ) VALUES ($1, $2::date, $3::date, $4, $5, $6, $7, $8, $9, false, NOW())
   ON CONFLICT (org_id, period_start, meter_kind) DO UPDATE SET
     period_end = EXCLUDED.period_end,
     quantity = CASE WHEN $10::boolean
                     THEN GREATEST(billing_meters.quantity, EXCLUDED.quantity)
                     ELSE EXCLUDED.quantity END,
     unit = EXCLUDED.unit,
     soft_limit = EXCLUDED.soft_limit,
     hard_limit = EXCLUDED.hard_limit,
     source = CASE WHEN $10::boolean AND billing_meters.quantity > EXCLUDED.quantity
                   THEN billing_meters.source ELSE EXCLUDED.source END,
     updated_at = NOW()`;

export type OrgMeterRefreshResult = {
  orgId: string;
  written: number;
  overHard: Array<MeterUpsert['kind']>;
  overSoft: Array<MeterUpsert['kind']>;
};

export async function writeOrgMeters(
  client: Queryable,
  reading: OrgMeterReading,
  caps: MeterCaps
): Promise<OrgMeterRefreshResult> {
  const upserts = meterUpserts(reading, caps);
  const overHard: OrgMeterRefreshResult['overHard'] = [];
  const overSoft: OrgMeterRefreshResult['overSoft'] = [];
  for (const u of upserts) {
    await client.query(METER_UPSERT_SQL, [
      reading.orgId,
      reading.periodStart,
      reading.periodEnd,
      u.kind,
      u.quantity,
      u.unit,
      u.soft,
      u.hard,
      u.source,
      u.monotonic,
    ]);
    if (u.hard != null && u.quantity >= u.hard) overHard.push(u.kind);
    else if (u.soft != null && u.quantity >= u.soft) overSoft.push(u.kind);
  }
  return { orgId: reading.orgId, written: upserts.length, overHard, overSoft };
}

export async function refreshOrgMetersInWorker(
  orgId: string,
  now: Date = new Date()
): Promise<OrgMeterRefreshResult> {
  const caps = meterCapsFromEnv();
  const window = meterWindow(now);
  return withOrgClient(orgId, async (client) => {
    const reading = await readOrgMeterReading(client, orgId, window);
    return writeOrgMeters(client, reading, caps);
  });
}

/** Orgs whose usage is metered: everything not deleted. Suspended orgs still accrue. */
export async function listBillableOrgIds(): Promise<string[]> {
  const db = await workerPool.connect();
  try {
    const res = await db.query<{ id: string }>(
      `SELECT id FROM orgs WHERE COALESCE(status, 'active') NOT IN ('soft_deleted', 'deleted', 'purged')`
    );
    return res.rows.map((r) => r.id);
  } finally {
    db.release();
  }
}
