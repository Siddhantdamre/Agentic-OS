/**
 * Insight engine (A3) + org playbook promotion helpers (A5 / B4).
 * Card numbers come from core-kpis.yaml SQL via metrics.query — never an
 * LLM scan of raw `messages`. Unknown metric ids are gaps, not invented KPIs.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { PoolClient } from 'pg';
import {
  METRIC_VALUE_KINDS,
  type GeneratedPlan,
  type InsightCard,
  type InsightCardStatus,
  type MetricDefinition,
  type MetricPoint,
  type MetricValueKind,
  type PlanStep,
} from '@darex/shared-types';

export const INSIGHT_METRIC_IDS = [
  'core.inquiries_unworked',
  'core.conversations_open',
  'core.needs_attention',
  'core.work_items_open',
  'core.messages_inbound',
  'core.revenue_collected_7d',
] as const;

export type InsightMetricId = (typeof INSIGHT_METRIC_IDS)[number];

export const INSIGHT_NAMED_WORKFLOWS = ['StaleChaseWorkflow', 'OwnerBriefingWorkflow'] as const;

export type InsightNamedWorkflow = (typeof INSIGHT_NAMED_WORKFLOWS)[number];

export const INSIGHT_CARD_TYPES = ['growth', 'efficiency', 'integration', 'attention'] as const;

export type InsightCardType = (typeof INSIGHT_CARD_TYPES)[number];

export type InsightCardView = InsightCard & {
  category: string;
  impact: string;
  actionLabel: string;
  actionHref: string;
  type: InsightCardType;
  recommendedAction?: string;
};

export type QueriedMetricPoint = MetricPoint & {
  description: string;
  insightCopy?: string;
  recommendedAction?: string;
  source?: string;
};

export type InsightMetricQuery = {
  orgId: string;
  points: QueriedMetricPoint[];
  gaps: string[];
  from: string;
  to: string;
};

export type OrgPromotedPlaybook = {
  playbookId: string;
  name: string;
  planId: string | null;
  steps: PlanStep[];
  summary: string;
  namedByUserId: string;
  createdAt: string;
};

function isInsightMetricId(id: string): id is InsightMetricId {
  return (INSIGHT_METRIC_IDS as readonly string[]).includes(id);
}

export function isInsightNamedWorkflow(value: string): value is InsightNamedWorkflow {
  return (INSIGHT_NAMED_WORKFLOWS as readonly string[]).includes(value);
}

export function recommendedWorkflowForMetric(metricId: string): InsightNamedWorkflow | null {
  if (!isInsightMetricId(metricId)) return null;
  switch (metricId) {
    case 'core.inquiries_unworked':
    case 'core.needs_attention':
      return 'StaleChaseWorkflow';
    case 'core.conversations_open':
    case 'core.work_items_open':
    case 'core.messages_inbound':
      return 'OwnerBriefingWorkflow';
    case 'core.revenue_collected_7d':
      return null;
    default: {
      const _exhaustive: never = metricId;
      return _exhaustive;
    }
  }
}

export function cardTypeForMetric(metricId: string): InsightCardType {
  if (!isInsightMetricId(metricId)) return 'efficiency';
  switch (metricId) {
    case 'core.inquiries_unworked':
    case 'core.needs_attention':
      return 'attention';
    case 'core.conversations_open':
    case 'core.work_items_open':
      return 'efficiency';
    case 'core.messages_inbound':
    case 'core.revenue_collected_7d':
      return 'growth';
    default: {
      const _exhaustive: never = metricId;
      return _exhaustive;
    }
  }
}

export function categoryForMetric(metricId: string): string {
  if (!isInsightMetricId(metricId)) return 'Metric';
  switch (metricId) {
    case 'core.inquiries_unworked':
      return 'Queue';
    case 'core.needs_attention':
      return 'Attention';
    case 'core.conversations_open':
      return 'Conversations';
    case 'core.work_items_open':
      return 'Work items';
    case 'core.messages_inbound':
      return 'Volume';
    case 'core.revenue_collected_7d':
      return 'Revenue';
    default: {
      const _exhaustive: never = metricId;
      return _exhaustive;
    }
  }
}

function actionHrefForMetric(metricId: string): string {
  if (!isInsightMetricId(metricId)) return '/analytics';
  switch (metricId) {
    case 'core.inquiries_unworked':
    case 'core.needs_attention':
    case 'core.conversations_open':
    case 'core.messages_inbound':
      return '/conversations';
    case 'core.work_items_open':
      return '/conversations';
    case 'core.revenue_collected_7d':
      return '/analytics';
    default: {
      const _exhaustive: never = metricId;
      return _exhaustive;
    }
  }
}

interface RegisteredMetric extends MetricDefinition {
  aliases: string[];
}

function isMetricValueKind(value: string): value is MetricValueKind {
  return (METRIC_VALUE_KINDS as readonly string[]).includes(value);
}

function parseFlowList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  return inner.split(',').map((part) => part.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

function parseKpiYaml(raw: string): RegisteredMetric[] {
  const metrics: RegisteredMetric[] = [];
  let current: Record<string, string | string[]> | null = null;
  let multilineKey: string | null = null;
  let multiline: string[] = [];

  const flushMulti = () => {
    if (current && multilineKey) {
      current[multilineKey] = multiline.join('\n').replace(/\n+$/, '');
    }
    multilineKey = null;
    multiline = [];
  };

  const flushCurrent = () => {
    flushMulti();
    if (!current || typeof current.id !== 'string' || !current.id) {
      current = null;
      return;
    }
    const valueKindRaw = typeof current.valueKind === 'string' ? current.valueKind : 'count';
    const valueKind: MetricValueKind = isMetricValueKind(valueKindRaw) ? valueKindRaw : 'count';
    const aliases = Array.isArray(current.aliases)
      ? current.aliases
      : typeof current.aliases === 'string'
        ? parseFlowList(current.aliases)
        : [];
    metrics.push({
      id: current.id,
      description: typeof current.description === 'string' ? current.description : current.id,
      valueKind,
      sql: typeof current.sql === 'string' ? current.sql : undefined,
      source: typeof current.source === 'string' ? current.source : undefined,
      insightCopy: typeof current.insightCopy === 'string' ? current.insightCopy : undefined,
      recommendedAction: typeof current.recommendedAction === 'string' ? current.recommendedAction : undefined,
      packId: typeof current.packId === 'string' ? current.packId : undefined,
      aliases,
    });
    current = null;
  };

  for (const line of raw.split('\n')) {
    if (multilineKey) {
      if (/^(\s{6}|\s{8})/.test(line) || (line.startsWith('      ') && !/^\s*-\s+id:/.test(line))) {
        multiline.push(line.replace(/^ {6,}/, '').replace(/^ {4}/, ''));
        continue;
      }
      if (line.trim() === '') {
        multiline.push('');
        continue;
      }
      flushMulti();
    }
    if (/^\s*#/.test(line) || line.trim() === '' || line.trim() === 'metrics:') continue;
    const item = line.match(/^\s*-\s+id:\s*(.+)\s*$/);
    if (item) {
      flushCurrent();
      current = { id: item[1].trim().replace(/^["']|["']$/g, '') };
      continue;
    }
    const kv = line.match(/^\s{2,}([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv || !current) continue;
    const key = kv[1];
    const value = kv[2];
    if (value === '|' || value === '>') {
      multilineKey = key;
      multiline = [];
      continue;
    }
    if (value.startsWith('[')) {
      current[key] = parseFlowList(value);
      continue;
    }
    current[key] = value.replace(/^["']|["']$/g, '');
  }
  flushCurrent();
  return metrics;
}

function kpiYamlCandidates(): string[] {
  const cwd = process.cwd();
  const candidates = [
    join(cwd, 'services/workflows/src/metrics/core-kpis.yaml'),
    join(cwd, '../../services/workflows/src/metrics/core-kpis.yaml'),
    join(cwd, '../services/workflows/src/metrics/core-kpis.yaml'),
    join(cwd, 'src/metrics/core-kpis.yaml'),
  ];
  if (typeof __dirname !== 'undefined') {
    candidates.push(join(__dirname, '../../../services/workflows/src/metrics/core-kpis.yaml'));
    candidates.push(join(__dirname, '../../services/workflows/src/metrics/core-kpis.yaml'));
  }
  return candidates;
}

let cachedKpis: RegisteredMetric[] | null = null;

export function loadCoreKpis(): RegisteredMetric[] {
  if (cachedKpis) return cachedKpis;
  const path = kpiYamlCandidates().find((p) => existsSync(p));
  if (!path) {
    throw new Error('core-kpis.yaml not found — insight cards cannot invent KPIs');
  }
  cachedKpis = parseKpiYaml(readFileSync(path, 'utf8'));
  return cachedKpis;
}

function normalizeNeedle(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

export function resolveMetrics(needles: string[]): { hits: RegisteredMetric[]; gaps: string[] } {
  const registry = loadCoreKpis();
  const hits: RegisteredMetric[] = [];
  const gaps: string[] = [];
  const seen = new Set<string>();
  for (const needle of needles) {
    const n = normalizeNeedle(needle);
    if (!n) continue;
    const match = registry.find((m) => {
      if (normalizeNeedle(m.id) === n) return true;
      return m.aliases.some((alias) => normalizeNeedle(alias) === n);
    });
    if (!match) {
      gaps.push(needle);
      continue;
    }
    if (seen.has(match.id)) continue;
    seen.add(match.id);
    hits.push(match);
  }
  return { hits, gaps };
}

function defaultRange(fromRaw?: string, toRaw?: string): { from: string; to: string } {
  const to = toRaw && !Number.isNaN(new Date(toRaw).getTime()) ? new Date(toRaw) : new Date();
  const from =
    fromRaw && !Number.isNaN(new Date(fromRaw).getTime())
      ? new Date(fromRaw)
      : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function bindRangeSql(sql: string): string {
  const trimmed = sql.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.includes(';') || (!lower.startsWith('select') && !lower.startsWith('with'))) {
    throw new Error('Metric SQL must be a single SELECT or WITH statement');
  }
  return trimmed.replace(/\$from\b/g, '$1').replace(/\$to\b/g, '$2');
}

/**
 * Run registered metric SQL under the caller's RLS session.
 * Does not interpolate org_id from the request — GUC + YAML SQL do that.
 */
export async function queryRegisteredMetrics(
  client: PoolClient,
  orgId: string,
  metricIds: string[] = [...INSIGHT_METRIC_IDS],
  fromRaw?: string,
  toRaw?: string
): Promise<InsightMetricQuery> {
  const range = defaultRange(fromRaw, toRaw);
  const { hits, gaps } = resolveMetrics(metricIds);
  const runtimeGaps = [...gaps];
  const points: QueriedMetricPoint[] = [];

  const connectedRes = await client.query(
    `SELECT channel_type FROM channels WHERE org_id = $1 AND status IN ('connected','active')`,
    [orgId]
  );
  const connected = new Set(
    connectedRes.rows.map((r: { channel_type?: string }) => String(r.channel_type || '').toLowerCase())
  );

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
      const sql = bindRangeSql(metric.sql);
      const res = await client.query(sql, [range.from, range.to]);
      const raw = res.rows[0]?.value;
      const value = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '0'));
      if (!Number.isFinite(value)) {
        runtimeGaps.push(metric.id);
        continue;
      }
      points.push({
        metricId: metric.id,
        value,
        from: range.from,
        to: range.to,
        description: metric.description,
        insightCopy: metric.insightCopy,
        recommendedAction: metric.recommendedAction,
        source: metric.source,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      runtimeGaps.push(`${metric.id}: ${message.slice(0, 180)}`);
    }
  }

  return { orgId, points, gaps: runtimeGaps, from: range.from, to: range.to };
}

function formatMetricValue(value: number, metricId: string): string {
  if (metricId === 'core.revenue_collected_7d') {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function buildInsightCards(query: InsightMetricQuery, generatedAt = new Date().toISOString()): InsightCardView[] {
  const cards: InsightCardView[] = [];

  for (const point of query.points) {
    const workflow = recommendedWorkflowForMetric(point.metricId);
    const type = cardTypeForMetric(point.metricId);
    const needsAction = point.value > 0 && Boolean(workflow);
    const status: InsightCardStatus = 'ok';
    const title = `${formatMetricValue(point.value, point.metricId)} — ${point.description}`;
    const narrative =
      point.insightCopy ||
      `${point.description} = ${formatMetricValue(point.value, point.metricId)} from the metrics registry SQL.`;
    cards.push({
      id: `ins-${point.metricId}`,
      orgId: query.orgId,
      metricId: point.metricId,
      title,
      narrative,
      value: point.value,
      status,
      recommendedWorkflow: workflow,
      generatedAt,
      category: categoryForMetric(point.metricId),
      impact: needsAction ? 'Action required' : 'Informational',
      actionLabel: workflow ? 'Review Action' : 'Open page',
      actionHref: actionHrefForMetric(point.metricId),
      type,
      recommendedAction: point.recommendedAction,
    });
  }

  for (const gap of query.gaps) {
    const metricId = gap.split(':')[0]?.trim() || gap;
    const def = loadCoreKpis().find((m) => m.id === metricId);
    const type: InsightCardType = gap.toLowerCase().includes('not connected')
      ? 'integration'
      : cardTypeForMetric(metricId);
    cards.push({
      id: `ins-gap-${metricId}`,
      orgId: query.orgId,
      metricId,
      title: def ? `${def.description} — not available` : `Metric unavailable`,
      narrative: `Honest gap: ${gap}. Darex will not invent this KPI.`,
      value: 0,
      status: 'gap',
      recommendedWorkflow: null,
      generatedAt,
      category: categoryForMetric(metricId),
      impact: 'Blocked',
      actionLabel: gap.toLowerCase().includes('not connected') ? 'Connect connector' : 'Open analytics',
      actionHref: gap.toLowerCase().includes('not connected') ? '/connectors' : '/analytics',
      type,
    });
  }

  return cards;
}

export function slugifyPlaybookName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug ? `org.${slug}` : '';
}

function isPlanStep(value: unknown): value is PlanStep {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === 'string' &&
    typeof rec.description === 'string' &&
    typeof rec.tool === 'string' &&
    typeof rec.action === 'string'
  );
}

export function sanitizePromotionSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: PlanStep[] = [];
  for (const item of raw) {
    if (!isPlanStep(item)) continue;
    steps.push({
      id: item.id,
      description: String(item.description).slice(0, 200),
      tool: String(item.tool).slice(0, 80),
      action: String(item.action).slice(0, 80),
      payload: {},
      enabled: item.enabled !== false,
    });
    if (steps.length >= 12) break;
  }
  return steps;
}

function isMissingRelation(err: unknown, table: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /does not exist/i.test(message) && message.includes(table);
}

export async function loadOrgPromotedPlaybooks(
  client: PoolClient,
  orgId: string
): Promise<OrgPromotedPlaybook[]> {
  try {
    const res = await client.query(
      `SELECT playbook_id, name, plan_id, steps, summary, named_by_user_id, created_at
       FROM org_playbook_promotions
       WHERE org_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [orgId]
    );
    return res.rows.map((row) => ({
      playbookId: String(row.playbook_id),
      name: String(row.name),
      planId: row.plan_id ? String(row.plan_id) : null,
      steps: sanitizePromotionSteps(row.steps),
      summary: String(row.summary || ''),
      namedByUserId: String(row.named_by_user_id),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  } catch (err: unknown) {
    if (isMissingRelation(err, 'org_playbook_promotions')) return [];
    throw err;
  }
}

export function matchOrgPromotedPlaybook(
  prompt: string,
  promotions: OrgPromotedPlaybook[]
): OrgPromotedPlaybook | null {
  const trimmed = (prompt || '').trim().toLowerCase();
  if (!trimmed || trimmed.length < 12) return null;
  if (/^\s*(hi|hello|hey|yo|thanks|thank you)\b/i.test(trimmed)) return null;

  let best: OrgPromotedPlaybook | null = null;
  let bestScore = 0;
  for (const promo of promotions) {
    const name = promo.name.trim().toLowerCase();
    const idTail = promo.playbookId.replace(/^org\./, '').replace(/-/g, ' ');
    if (!name || name.length < 3) continue;
    const hit = trimmed.includes(name) || (idTail.length >= 4 && trimmed.includes(idTail));
    if (!hit) continue;
    const score = name.length;
    if (score > bestScore) {
      best = promo;
      bestScore = score;
    }
  }
  return best;
}

export function orgPlaybookToPlan(promo: OrgPromotedPlaybook, prompt: string): GeneratedPlan {
  return {
    reasoning: `Matched org playbook ${promo.playbookId} (human-named: ${promo.name}). Replay uses the playbook matcher, not a new runtime. User asked: ${prompt.slice(0, 180)}`,
    steps: promo.steps.map((s) => ({ ...s, payload: { ...(s.payload || {}) } })),
    draft: '',
    summary: promo.summary || promo.name,
  };
}

export function listRegisteredMetricIds(): string[] {
  return loadCoreKpis().map((m) => m.id);
}
