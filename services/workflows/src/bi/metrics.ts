/**
 * Semantic layer: named metrics with fixed, reviewed SQL. The analyst never
 * writes SQL; it picks a metric and supplies typed parameters.
 *
 * Templates use `@org` (always required, becomes $1) and `@name` for each
 * declared param (becomes $2, $3 ... in declaration order). renderQuery
 * output is meant for the app's tenant-scoped client (RLS set to the org),
 * not for the restricted model SQL role.
 */
import { checkReadOnlySql } from '../tools/sql-guard.js';
import type { Unit } from './numbers.js';

export interface ParamDef { name: string; type: 'date' | 'int' | 'text' }
export interface MetricDef { id: string; label: string; unit: Unit; sql: string; params: ParamDef[] }
export interface RenderedQuery { text: string; values: unknown[] }

const asOf: ParamDef[] = [{ name: 'as_of', type: 'date' }];
const range: ParamDef[] = [{ name: 'from', type: 'date' }, { name: 'to', type: 'date' }];

export const METRICS: MetricDef[] = [
  { id: 'overdue_total', label: 'Overdue dues (total)', unit: 'inr', params: asOf,
    sql: `SELECT COALESCE(SUM(amount), 0)::float8 AS value FROM org_dues WHERE org_id = @org AND status = 'open' AND due_date < @as_of::date` },
  { id: 'overdue_count', label: 'Overdue invoices (count)', unit: 'count', params: asOf,
    sql: `SELECT COUNT(*)::int AS value FROM org_dues WHERE org_id = @org AND status = 'open' AND due_date < @as_of::date` },
  { id: 'overdue_share', label: 'Overdue share of open dues', unit: 'percent', params: asOf,
    sql: `SELECT (100.0 * SUM(amount) FILTER (WHERE due_date < @as_of::date) / NULLIF(SUM(amount), 0))::float8 AS value FROM org_dues WHERE org_id = @org AND status = 'open'` },
  { id: 'paid_in_range', label: 'Payments received', unit: 'inr', params: range,
    sql: `SELECT COALESCE(SUM(amount), 0)::float8 AS value FROM org_dues WHERE org_id = @org AND status = 'paid' AND paid_at >= @from::date AND paid_at < (@to::date + 1)` },
  { id: 'inquiries_in_range', label: 'New inquiries', unit: 'count', params: range,
    sql: `SELECT COUNT(*)::int AS value FROM re_inquiries WHERE org_id = @org AND deleted_at IS NULL AND created_at >= @from::date AND created_at < (@to::date + 1)` },
  { id: 'inquiries_closed', label: 'Inquiries closed', unit: 'count', params: range,
    sql: `SELECT COUNT(*)::int AS value FROM re_inquiries WHERE org_id = @org AND deleted_at IS NULL AND status = 'closed' AND updated_at >= @from::date AND updated_at < (@to::date + 1)` },
  { id: 'active_listings', label: 'Active listings', unit: 'count', params: [],
    sql: `SELECT COUNT(*)::int AS value FROM re_listings WHERE org_id = @org AND status = 'active'` },
];

export const METRIC_BY_ID: Record<string, MetricDef> = Object.fromEntries(METRICS.map((m) => [m.id, m]));

const PLACEHOLDER = /@([a-z_]+)/g;
const isRealDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
  && new Date(s).toISOString().slice(0, 10) === s;

/** Throws on a def that is not one tenant-scoped SELECT. Returns nothing. */
export function validateDef(def: MetricDef): void {
  const fail = (why: string) => { throw new Error(`metric ${def.id}: ${why}`); };
  const names = [...def.sql.matchAll(PLACEHOLDER)].map((m) => m[1]);
  const declared = new Set(def.params.map((p) => p.name));
  for (const n of names) if (n !== 'org' && !declared.has(n)) fail(`undeclared placeholder @${n}`);
  for (const n of declared) if (!names.includes(n)) fail(`param @${n} is declared but unused`);
  const guard = checkReadOnlySql(def.sql.replace(PLACEHOLDER, '0'));
  if (!guard.ok) fail(guard.reason || 'not a read-only single SELECT');
  if (!/\borg_id\s*=\s*@org\b/.test(def.sql)) fail('missing org_id = @org scope');
  const sources = (def.sql.match(/\b(from|join)\s/gi) || []).length;
  const scopes = (def.sql.match(/\borg_id\s*=\s*@org\b/g) || []).length;
  if (scopes < sources) fail('every FROM/JOIN needs its own org_id = @org');
}

export function renderQuery(def: MetricDef, params: Record<string, unknown>, orgId: string): RenderedQuery {
  validateDef(def);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw new Error('orgId must be a uuid');
  }
  for (const k of Object.keys(params)) {
    if (!def.params.some((p) => p.name === k)) throw new Error(`metric ${def.id}: unknown param ${k}`);
  }
  const values: unknown[] = [orgId];
  const pos: Record<string, number> = { org: 1 };
  def.params.forEach((p, i) => {
    const v = params[p.name];
    const ok = p.type === 'date' ? typeof v === 'string' && isRealDate(v)
      : p.type === 'int' ? Number.isInteger(v)
      : typeof v === 'string';
    if (!ok) throw new Error(`metric ${def.id}: param ${p.name} must be a valid ${p.type}`);
    values.push(v);
    pos[p.name] = i + 2;
  });
  return { text: def.sql.replace(PLACEHOLDER, (_m, n: string) => `$${pos[n]}`), values };
}
