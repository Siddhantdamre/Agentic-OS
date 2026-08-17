import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { MetricDefinition, MetricPoint, MetricValueKind } from '@darex/shared-types';
import { METRIC_VALUE_KINDS } from '@darex/shared-types';
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, withOrgScopedClient } from './shared.js';

const ACTIONS = ['query', 'list'] as const;

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
  const candidates: string[] = [];
  if (typeof __dirname !== 'undefined') {
    candidates.push(join(__dirname, '../metrics/core-kpis.yaml'));
    candidates.push(join(__dirname, '../../src/metrics/core-kpis.yaml'));
  }
  candidates.push(join(process.cwd(), 'src/metrics/core-kpis.yaml'));
  candidates.push(join(process.cwd(), 'services/workflows/src/metrics/core-kpis.yaml'));
  candidates.push(join(process.cwd(), '../../services/workflows/src/metrics/core-kpis.yaml'));
  return candidates;
}

let cached: RegisteredMetric[] | null = null;

export function loadCoreKpis(): RegisteredMetric[] {
  if (cached) return cached;
  const path = kpiYamlCandidates().find((p) => existsSync(p));
  if (!path) {
    throw new Error('core-kpis.yaml not found — metrics.query cannot run without the registry');
  }
  cached = parseKpiYaml(readFileSync(path, 'utf8'));
  return cached;
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

function assertSafeSql(sql: string): string {
  const trimmed = sql.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.includes(';') || (!lower.startsWith('select') && !lower.startsWith('with'))) {
    throw new Error('Metric SQL must be a single SELECT or WITH statement');
  }
  return trimmed;
}

function bindRangeSql(sql: string): string {
  return assertSafeSql(sql).replace(/\$from\b/g, '$1').replace(/\$to\b/g, '$2');
}

function defaultRange(fromRaw: unknown, toRaw: unknown): { from: string; to: string } {
  const to = typeof toRaw === 'string' && toRaw.trim() ? new Date(toRaw) : new Date();
  const from = typeof fromRaw === 'string' && fromRaw.trim()
    ? new Date(fromRaw)
    : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromIso = Number.isNaN(from.getTime()) ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() : from.toISOString();
  const toIso = Number.isNaN(to.getTime()) ? new Date().toISOString() : to.toISOString();
  return { from: fromIso, to: toIso };
}

function riskFor(_action: string): ToolRisk {
  return 'read';
}

function collectNeedles(payload: Record<string, unknown>): string[] {
  const ids = payload.metricIds || payload.ids || payload.metric_ids;
  const needles: string[] = [];
  if (Array.isArray(ids)) {
    for (const id of ids) {
      if (typeof id === 'string' && id.trim()) needles.push(id);
    }
  } else if (typeof ids === 'string' && ids.trim()) {
    needles.push(ids);
  }
  const q = payload.query || payload.q || payload.metric || payload.id;
  if (typeof q === 'string' && q.trim()) needles.push(q);
  return needles;
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const action = actionName.includes('list') ? 'list' : 'query';

  try {
    switch (action) {
      case 'list': {
        const registry = loadCoreKpis();
        return {
          tool: 'metrics',
          action: 'list',
          status: 'executed' as const,
          message: `${registry.length} registered metric${registry.length === 1 ? '' : 's'}`,
          data: {
            metrics: registry.map((m) => ({
              id: m.id,
              description: m.description,
              valueKind: m.valueKind,
              aliases: m.aliases,
            })),
          },
          timestamp,
        };
      }
      case 'query': {
        const needles = collectNeedles(payload);
        const { hits, gaps } = resolveMetrics(needles);
        const range = defaultRange(payload.from, payload.to);
        const points: MetricPoint[] = [];
        const runtimeGaps = [...gaps];

        await withOrgScopedClient(orgId, async (client) => {
          for (const metric of hits) {
            if (!metric.sql) {
              runtimeGaps.push(metric.id);
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
              });
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              runtimeGaps.push(`${metric.id}: ${message.slice(0, 180)}`);
            }
          }
        });

        return {
          tool: 'metrics',
          action: 'query',
          status: 'executed' as const,
          message: points.length
            ? `Returned ${points.length} metric point${points.length === 1 ? '' : 's'} from the registry (not free SQL)`
            : 'No metric points. Unknown ids are listed in gaps — use metrics.list.',
          data: { orgId, points, gaps: runtimeGaps, from: range.from, to: range.to },
          timestamp,
        };
      }
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      tool: 'metrics',
      action,
      status: 'error' as const,
      message: `metrics.${action} failed: ${message}`,
      data: null,
      timestamp,
    };
  }
}

export const metrics: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
