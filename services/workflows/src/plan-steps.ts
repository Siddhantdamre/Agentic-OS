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
  /** Stamped at plan creation; the step runs as this employee. */
  employeeId?: string;
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
    case 'execute':
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
    for (let rIdx = lastNonFailed.length - 1; rIdx >= 0; rIdx--) {
      const result = lastNonFailed[rIdx];
      for (const key of keys) {
        const value = result?.[key];
        if (value) return String(value);
      }
      for (const sub of Object.values(result)) {
        if (sub && typeof sub === 'object') {
          for (const key of keys) {
            const val = (sub as Record<string, unknown>)?.[key];
            if (val) return String(val);
          }
        }
      }
    }
    return undefined;
  };

  const normTool = String(step.tool || '').toLowerCase().replace(/_/g, '-');
  const action = String(step.action || '');

  if (normTool === 'google-sheets' && !payload.spreadsheetId && !payload.spreadsheet_id && (action === 'sheets_read' || action === 'sheets_append_row' || action === 'sheets_append')) {
    const spreadsheetId = pick(['spreadsheetId', 'spreadsheet_id', 'id']);
    if (spreadsheetId) {
      payload.spreadsheetId = spreadsheetId;
      payload.spreadsheet_id = spreadsheetId;
    }
  }
  if (normTool === 'google-docs' && !payload.documentId && !payload.document_id && (action === 'docs_read' || action === 'docs_append')) {
    const documentId = pick(['documentId', 'document_id', 'id']);
    if (documentId) {
      payload.documentId = documentId;
      payload.document_id = documentId;
    }
  }
  if (normTool === 'google-drive' && !payload.fileId && !payload.file_id && (action === 'drive_get_text' || action === 'drive_share')) {
    const fileId = pick(['fileId', 'file_id', 'id']);
    if (fileId) {
      payload.fileId = fileId;
      payload.file_id = fileId;
    }
  }
  if (normTool === 'google-slides' && !payload.presentationId && !payload.presentation_id && (action === 'slides_add_slide' || action === 'slides_get')) {
    const presentationId = pick(['presentationId', 'presentation_id', 'id']);
    if (presentationId) {
      payload.presentationId = presentationId;
      payload.presentation_id = presentationId;
    }
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
  const stagedIndices = new Set<number>();

  const dependsOnEarlier = (step: PlanStepLike, currentRemainingIndex: number) => {
    const payloadStr = String(JSON.stringify(step.payload || ''));
    const stepOutputMatches = payloadStr.matchAll(/\{\{step(\d+)_output\}\}/g);
    for (const match of stepOutputMatches) {
      const stepIdx = parseInt(match[1], 10) - 1;
      if (!stagedIndices.has(stepIdx)) {
        return true;
      }
    }

    const normTool = String(step.tool || '').toLowerCase().replace(/_/g, '-');
    const action = String(step.action || '');
    const p = step.payload as Record<string, any> | undefined;

    if (normTool === 'google-sheets' && ['sheets_read', 'sheets_append_row', 'sheets_append'].includes(action) && !p?.spreadsheetId && !p?.spreadsheet_id) {
      const hasPriorCreator = steps.slice(0, currentRemainingIndex).some((prev) => {
        const prevTool = String(prev.tool || '').toLowerCase().replace(/_/g, '-');
        return prevTool === 'google-sheets';
      });
      if (hasPriorCreator) {
        const priorCreatorStaged = steps.slice(0, currentRemainingIndex).some((prev, prevIdx) => {
          const prevTool = String(prev.tool || '').toLowerCase().replace(/_/g, '-');
          return prevTool === 'google-sheets' && stagedIndices.has(prevIdx);
        });
        if (!priorCreatorStaged) return true;
      }
    }

    if (normTool === 'google-docs' && ['docs_read', 'docs_append'].includes(action) && !p?.documentId && !p?.document_id) {
      const hasPriorCreator = steps.slice(0, currentRemainingIndex).some((prev) => {
        const prevTool = String(prev.tool || '').toLowerCase().replace(/_/g, '-');
        return prevTool === 'google-docs';
      });
      if (hasPriorCreator) {
        const priorCreatorStaged = steps.slice(0, currentRemainingIndex).some((prev, prevIdx) => {
          const prevTool = String(prev.tool || '').toLowerCase().replace(/_/g, '-');
          return prevTool === 'google-docs' && stagedIndices.has(prevIdx);
        });
        if (!priorCreatorStaged) return true;
      }
    }

    if (normTool === 'google-drive' && ['drive_get_text', 'drive_share'].includes(action) && !p?.fileId && !p?.file_id) {
      const hasPriorCreator = steps.slice(0, currentRemainingIndex).some((prev) => {
        const prevTool = String(prev.tool || '').toLowerCase().replace(/_/g, '-');
        return prevTool === 'google-drive' || prevTool === 'google-docs' || prevTool === 'google-sheets' || prevTool === 'google-slides';
      });
      if (hasPriorCreator) {
        const priorCreatorStaged = steps.slice(0, currentRemainingIndex).some((prev, prevIdx) => {
          const prevTool = String(prev.tool || '').toLowerCase().replace(/_/g, '-');
          return (prevTool === 'google-drive' || prevTool === 'google-docs' || prevTool === 'google-sheets' || prevTool === 'google-slides') && stagedIndices.has(prevIdx);
        });
        if (!priorCreatorStaged) return true;
      }
    }

    if (normTool === 'google-slides' && ['slides_add_slide', 'slides_get'].includes(action) && !p?.presentationId && !p?.presentation_id) {
      const hasPriorCreator = steps.slice(0, currentRemainingIndex).some((prev) => {
        const prevTool = String(prev.tool || '').toLowerCase().replace(/_/g, '-');
        return prevTool === 'google-slides';
      });
      if (hasPriorCreator) {
        const priorCreatorStaged = steps.slice(0, currentRemainingIndex).some((prev, prevIdx) => {
          const prevTool = String(prev.tool || '').toLowerCase().replace(/_/g, '-');
          return prevTool === 'google-slides' && stagedIndices.has(prevIdx);
        });
        if (!priorCreatorStaged) return true;
      }
    }

    return false;
  };

  let remaining = steps.map((s, i) => ({ s, i }));
  while (remaining.length > 0) {
    const stage: StagedPlanStep[] = [];
    const stageIdx = new Set<number>();
    for (const item of remaining) {
      if (!dependsOnEarlier(item.s, item.i)) {
        stage.push(item);
        stageIdx.add(item.i);
      }
    }
    if (stage.length === 0) {
      stage.push(remaining[0]);
      stageIdx.add(remaining[0].i);
    }
    for (const id of stageIdx) {
      stagedIndices.add(id);
    }
    remaining = remaining.filter((item) => !stageIdx.has(item.i));
    stages.push(stage);
  }
  return stages;
}

export const CORE_PLAN_EXECUTE_TOOLS = [
  'web_search', 'web_extract', 'database_query', 'db_query', 'sql_analytics',
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
