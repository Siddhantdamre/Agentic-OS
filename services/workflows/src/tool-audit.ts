/**
 * Append-only tool invocation audit (RT-G06, migration 126).
 * One row per executeAutonomousToolAction call. Best-effort: a failed write
 * is logged and never blocks or changes the tool result.
 */

import { createHash } from 'node:crypto';
import type { ToolExecutionParams, ToolExecutionResult } from '@darex/shared-types';
import { isUndefinedTable, withOrgClient } from './db.js';
import { resolveToolRisk } from './tools/index.js';

export interface ToolInvocationRow {
  orgId: string;
  employeeRole: string | null;
  workflowId: string | null;
  tool: string;
  action: string;
  risk: string | null;
  argsHash: string;
  status: string;
  latencyMs: number;
  error: string | null;
}

/** JSON with object keys sorted at every depth, so equal args hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function argsHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload ?? {})).digest('hex');
}

export function buildToolInvocationRow(input: {
  params: ToolExecutionParams;
  employeeRole?: string;
  workflowId?: string;
  result?: ToolExecutionResult;
  thrown?: unknown;
  latencyMs: number;
}): ToolInvocationRow {
  const tool = (input.params.tool || '').toLowerCase();
  const action = (input.params.action || 'auto_execute').toLowerCase();
  let risk: string | null = null;
  try {
    risk = resolveToolRisk(tool, action)?.risk ?? null;
  } catch {
    risk = null; // unknown module/action: audited with no risk class
  }
  const status = input.thrown ? 'thrown' : input.result?.status || 'unknown';
  const errorText = input.thrown
    ? input.thrown instanceof Error ? input.thrown.message : String(input.thrown)
    : input.result?.status === 'error' ? input.result.message : null;
  return {
    orgId: input.params.orgId,
    employeeRole: input.employeeRole || null,
    workflowId: input.workflowId || null,
    tool,
    action,
    risk,
    argsHash: argsHash(input.params.payload),
    status,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    error: errorText ? errorText.slice(0, 500) : null,
  };
}

/** Build + write without ever throwing into the caller's tool path. */
export function auditToolInvocation(input: Parameters<typeof buildToolInvocationRow>[0]): void {
  let row: ToolInvocationRow;
  try {
    row = buildToolInvocationRow(input);
  } catch (err) {
    console.warn('[tool-audit] could not build audit row:', err instanceof Error ? err.message : err);
    return;
  }
  void recordToolInvocation(row);
}

export async function recordToolInvocation(row: ToolInvocationRow): Promise<void> {
  if (!row.orgId) return;
  try {
    await withOrgClient(row.orgId, (client) =>
      client.query(
        `INSERT INTO tool_invocations
           (org_id, employee_role, workflow_id, tool, action, risk, args_hash, status, latency_ms, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.orgId,
          row.employeeRole,
          row.workflowId,
          row.tool,
          row.action,
          row.risk,
          row.argsHash,
          row.status,
          row.latencyMs,
          row.error,
        ]
      )
    );
  } catch (err) {
    if (isUndefinedTable(err)) {
      console.warn('[tool-audit] tool_invocations missing (migration 126 not applied)');
      return;
    }
    console.warn(
      `[tool-audit] audit write failed org=${row.orgId} tool=${row.tool}.${row.action}:`,
      err instanceof Error ? err.message : err
    );
  }
}
