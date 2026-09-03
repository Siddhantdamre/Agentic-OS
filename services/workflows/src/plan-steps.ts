/**
 * Shared plan DAG helpers for Ask AI execute (SSE) and PlanExecuteWorkflow.
 * Pure enough for Node activities + the dashboard route. Not imported from
 * Temporal workflow isolates (those receive pre-staged steps from activities).
 */

import { resolveToolRisk } from './tools/index.js';
import type { ToolRisk } from './tools/risk.js';

export type PlanStepLike = {
  id?: string;
  description?: string;
  tool?: string;
  action?: string;
  payload?: Record<string, unknown>;
  enabled?: boolean;
};

export function isDurablePlanRisk(risk: ToolRisk): boolean {
  switch (risk) {
    case 'read':
    case 'draft':
      return false;
    case 'send':
    case 'pay':
    case 'sign':
    case 'publish':
    case 'delete':
      return true;
    default: {
      const _exhaustive: never = risk;
      return _exhaustive;
    }
  }
}

/**
 * O4: send/pay/sign/publish/delete must run as Temporal so a dashboard
 * restart cannot drop a live send. read/draft stay on HTTP SSE.
 */
export function planRequiresDurableExecute(steps: PlanStepLike[]): boolean {
  for (const step of steps) {
    if (step.enabled === false) continue;
    const tool = String(step.tool || '');
    const action = String(step.action || '');
    const resolved = resolveToolRisk(tool, action);
    if (resolved && isDurablePlanRisk(resolved.risk)) return true;
    const a = action.toLowerCase();
    const t = tool.toLowerCase();
    if (a.includes('send_email') || a.includes('send_whatsapp') || a.includes('send_message')) return true;
    if (a.includes('send') && (t.includes('gmail') || t.includes('whatsapp') || t.includes('slack') || t.includes('twilio'))) {
      return true;
    }
    if (a.includes('pay') || a.includes('charge') || a.includes('sign') || a.includes('publish') || a.includes('delete')) {
      return true;
    }
  }
  return false;
}

export function wireDependencies(step: PlanStepLike, previousResults: Array<Record<string, unknown>>): Record<string, unknown> {
  const payload = { ...(step.payload || {}) };
  const lastNonFailed = previousResults
    .filter((r) => r && r.status === 'executed')
    .map((r) => (r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : {}));
  const pick = (keys: string[]): string | undefined => {
    for (const result of lastNonFailed) {
      for (const key of keys) {
        const value = result?.[key];
        if (value) return String(value);
      }
    }
    return undefined;
  };

  if (step.tool === 'google-sheets' && !payload.spreadsheetId && (step.action === 'sheets_read' || step.action === 'sheets_append_row')) {
    const spreadsheetId = pick(['spreadsheetId', 'spreadsheet_id', 'id']);
    if (spreadsheetId) payload.spreadsheetId = spreadsheetId;
  }
  if (step.tool === 'google-docs' && !payload.documentId && (step.action === 'docs_read' || step.action === 'docs_append')) {
    const documentId = pick(['documentId', 'document_id', 'id']);
    if (documentId) payload.documentId = documentId;
  }
  if (step.tool === 'google-drive' && !payload.fileId && (step.action === 'drive_get_text' || step.action === 'drive_share')) {
    const fileId = pick(['fileId', 'file_id', 'id']);
    if (fileId) payload.fileId = fileId;
  }

  function interpolate(value: unknown): unknown {
    if (typeof value === 'string') {
      return value.replace(/\{\{step(\d+)_output\}\}/g, (_match, stepNum) => {
        const idx = parseInt(stepNum, 10) - 1;
        if (idx >= 0 && idx < previousResults.length) {
          const res = previousResults[idx];
          if (res && res.status === 'executed' && res.data && typeof res.data === 'object') {
            const data = res.data as Record<string, unknown>;
            if (data.results) return JSON.stringify(data.results, null, 2);
            if (data.content) return String(data.content);
            return JSON.stringify(data, null, 2);
          }
        }
        return '';
      });
    }
    if (Array.isArray(value)) return value.map(interpolate);
    if (value !== null && typeof value === 'object') {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        obj[k] = interpolate(v);
      }
      return obj;
    }
    return value;
  }

  return interpolate(payload) as Record<string, unknown>;
}

export type StagedPlanStep = { s: PlanStepLike; i: number };

export function stageSteps(steps: PlanStepLike[]): StagedPlanStep[][] {
  const stages: StagedPlanStep[][] = [];
  const dependsOnEarlier = (step: PlanStepLike) => {
    const payloadStr = String(JSON.stringify(step.payload || ''));
    if (/\{\{step\d+_output\}\}/.test(payloadStr)) return true;
    if (step.tool === 'google-sheets' && ['sheets_read', 'sheets_append_row'].includes(String(step.action)) && !(step.payload as { spreadsheetId?: string } | undefined)?.spreadsheetId) {
      return true;
    }
    if (step.tool === 'google-docs' && ['docs_read', 'docs_append'].includes(String(step.action)) && !(step.payload as { documentId?: string } | undefined)?.documentId) {
      return true;
    }
    if (step.tool === 'google-drive' && ['drive_get_text', 'drive_share'].includes(String(step.action)) && !(step.payload as { fileId?: string } | undefined)?.fileId) {
      return true;
    }
    return false;
  };

  let remaining = steps.map((s, i) => ({ s, i }));
  while (remaining.length > 0) {
    const stage: StagedPlanStep[] = [];
    const stageIdx = new Set<number>();
    for (const item of remaining) {
      if (!dependsOnEarlier(item.s)) {
        stage.push(item);
        stageIdx.add(item.i);
      }
    }
    if (stage.length === 0) {
      stage.push(remaining[0]);
      stageIdx.add(remaining[0].i);
    }
    remaining = remaining.filter((item) => !stageIdx.has(item.i));
    stages.push(stage);
  }
  return stages;
}

export const CORE_PLAN_EXECUTE_TOOLS = [
  'web_search', 'web_extract', 'deep_research', 'database_query', 'db_query', 'sql_analytics',
  'metrics', 'metrics_query',
  'file_ops', 'workspace_file', 'file_system', 'sandbox', 'code_execution', 'execute_code',
];

export function planExecuteAllowlist(steps: PlanStepLike[]): string[] {
  return Array.from(
    new Set<string>([
      ...CORE_PLAN_EXECUTE_TOOLS,
      ...steps.map((s) => String(s.tool || '').toLowerCase()).filter(Boolean),
    ])
  );
}
