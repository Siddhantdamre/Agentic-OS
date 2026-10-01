/**
 * Dual-bound employee health metrics (14). Zero is an alert. So is a
 * number that is too good. Evaluate per org — aggregates hide silence.
 */

export type EmployeeMetricId =
  | 'approval_rate'
  | 'escalation_rate'
  | 'time_to_decision_p50_hours'
  | 'obligations_per_100_messages'
  | 'grounding_rejection_rate'
  | 'open_discrepancies_per_day'
  | 'autonomous_action_share'
  | 'suppression_rate'
  | 'outbound_per_customer_day'
  | 'confidence_calibration_drift';

export interface MetricBand {
  id: EmployeeMetricId;
  low: number;
  high: number;
  alertOnZero: boolean;
}

export const EMPLOYEE_METRIC_BANDS: Record<EmployeeMetricId, MetricBand> = {
  approval_rate: { id: 'approval_rate', low: 0.6, high: 0.9, alertOnZero: false },
  escalation_rate: { id: 'escalation_rate', low: 0.05, high: 0.25, alertOnZero: true },
  time_to_decision_p50_hours: { id: 'time_to_decision_p50_hours', low: 0, high: 4, alertOnZero: false },
  obligations_per_100_messages: { id: 'obligations_per_100_messages', low: 8, high: 25, alertOnZero: true },
  grounding_rejection_rate: { id: 'grounding_rejection_rate', low: 0.01, high: 0.15, alertOnZero: true },
  open_discrepancies_per_day: { id: 'open_discrepancies_per_day', low: 1, high: Number.POSITIVE_INFINITY, alertOnZero: true },
  autonomous_action_share: { id: 'autonomous_action_share', low: 0, high: 1, alertOnZero: false },
  suppression_rate: { id: 'suppression_rate', low: 0, high: 0.7, alertOnZero: false },
  outbound_per_customer_day: { id: 'outbound_per_customer_day', low: 0, high: Number.POSITIVE_INFINITY, alertOnZero: false },
  confidence_calibration_drift: { id: 'confidence_calibration_drift', low: 0, high: 0.1, alertOnZero: false },
};

export type MetricAlertKind = 'ok' | 'below' | 'above' | 'zero';

export interface MetricEvaluation {
  id: EmployeeMetricId;
  orgId: string;
  value: number;
  kind: MetricAlertKind;
}

export function evaluateEmployeeMetric(
  orgId: string,
  id: EmployeeMetricId,
  value: number,
): MetricEvaluation {
  const band = EMPLOYEE_METRIC_BANDS[id];
  if (band.alertOnZero && value === 0) {
    return { id, orgId, value, kind: 'zero' };
  }
  if (value < band.low) return { id, orgId, value, kind: 'below' };
  if (value > band.high) return { id, orgId, value, kind: 'above' };
  return { id, orgId, value, kind: 'ok' };
}

/** Structured log fields required by 14 §4. Never include message bodies. */
export function employeeDecisionLogFields(input: {
  orgId: string;
  employeeRole: string;
  workflowId?: string;
  runId?: string;
  actionType: string;
  decision: string;
  reasonCode: string;
  confidence: number;
  promptVersion?: string;
}): Record<string, string | number> {
  return {
    org_id: input.orgId,
    employee_role: input.employeeRole,
    workflow_id: input.workflowId ?? '',
    run_id: input.runId ?? '',
    action_type: input.actionType,
    decision: input.decision,
    reason_code: input.reasonCode,
    confidence: input.confidence,
    prompt_version: input.promptVersion ?? '',
  };
}

export interface EmployeeMetricRecordInput {
  orgId: string;
  employeeRole: string;
  actionType: string;
  decision: 'executed' | 'declined' | 'suppressed' | 'deferred' | 'escalated';
  reasonCode: string;
  confidence?: number;
  workflowId?: string;
  runId?: string;
}

/**
 * Record a decision event for an employee, returning the structured log fields.
 */
export function recordEmployeeMetrics(input: EmployeeMetricRecordInput): Record<string, string | number> {
  const fields = employeeDecisionLogFields({
    orgId: input.orgId,
    employeeRole: input.employeeRole,
    workflowId: input.workflowId,
    runId: input.runId,
    actionType: input.actionType,
    decision: input.decision,
    reasonCode: input.reasonCode,
    confidence: input.confidence ?? 1.0,
  });
  return fields;
}
