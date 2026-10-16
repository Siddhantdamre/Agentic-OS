/**
 * "Ask your numbers": a read-only, number-checked answer about money owed, payments, enquiries and listings.
 * The number comes from a fixed, read-only query scoped to this workspace; the wording is a template, not a model.
 * A question that does not map cleanly to one metric gets "I can't compute that yet", never a guess.
 */
import { buildAnswer, resolveMetric } from '../bi/answer.js';
import { METRIC_BY_ID, renderQuery } from '../bi/metrics.js';
import { verifyAnswer, type ComputedValue } from '../bi/numbers.js';
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, withOrgScopedClient } from './shared.js';

const ACTIONS = ['read', 'ask', 'query'] as const;
const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function riskFor(_action: string): ToolRisk {
  return 'read';
}

/** Dates are UTC calendar dates; the answer says which dates it used, so the owner can see the period. */
export function defaultPeriod(now: Date, days = 30): { asOf: string; from: string; to: string } {
  return { asOf: iso(now), from: iso(new Date(now.getTime() - days * DAY_MS)), to: iso(now) };
}

async function execute(ctx: ToolActionContext) {
  const { orgId, payload, timestamp, actionName } = ctx;
  const question = String(payload.question ?? payload.query ?? '').slice(0, 500);
  const base = { tool: 'ask_numbers', action: actionName || 'read', timestamp };
  const id = resolveMetric(question.toLowerCase());
  const def = id && id !== 'ambiguous' ? METRIC_BY_ID[id] : null;
  if (!def) {
    const a = buildAnswer(question, []);
    return { ...base, status: 'executed' as const, message: a.text, data: { ...a, computed: false } };
  }
  const period = defaultPeriod(new Date());
  const params: Record<string, unknown> = {};
  for (const p of def.params) params[p.name] = p.name === 'as_of' ? period.asOf : p.name === 'from' ? period.from : period.to;
  try {
    const q = renderQuery(def, params, orgId);
    const value = await withOrgScopedClient(orgId, async (client) => {
      const res = await client.query<{ value: number | string | null }>(q.text, q.values);
      const raw = res.rows[0]?.value;
      return raw === null || raw === undefined ? NaN : Number(raw);
    });
    const computed: ComputedValue = {
      id: def.id,
      label: def.label,
      unit: def.unit,
      value,
      query: def.sql,
      period: def.params.some((p) => p.name === 'as_of') ? { asOf: period.asOf } : def.params.length ? { from: period.from, to: period.to } : {},
    };
    const answer = buildAnswer(question, [computed]);
    // Belt and braces: whatever text goes out must contain only numbers that were computed.
    const check = verifyAnswer(answer.text, [computed]);
    if (!check.ok) {
      return { ...base, status: 'error' as const, message: "I couldn't verify that number, so I'm not showing it.", data: { computed: false } };
    }
    return { ...base, status: 'executed' as const, message: answer.text, data: { ...answer, computed: true } };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, status: 'error' as const, message: `Numbers unavailable: ${message}`, data: { computed: false } };
  }
}

export const askNumbers: ToolModule = { actions: ACTIONS, risk: riskFor, confirm: confirmFromRisk(riskFor), execute };
