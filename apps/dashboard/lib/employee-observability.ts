export type BandStatus = 'healthy' | 'alert' | 'unknown';
export type LedgerDecision = 'executed' | 'deferred' | 'declined' | 'escalated' | 'suppressed';
export type SilentMetricKey =
  | 'approval_rate' | 'escalation_rate' | 'time_to_decision' | 'obligations_per_100'
  | 'grounding_rejection_rate' | 'open_discrepancies' | 'autonomous_action_share'
  | 'suppression_rate' | 'outbound_per_customer' | 'confidence_calibration_drift';
export interface SilentMetric {
  key: SilentMetricKey; label: string; value: number | null; unit: string;
  healthyLow: number | null; healthyHigh: number | null; status: BandStatus; alertReason: string | null;
}
export interface StructuredDecisionLog {
  org_id: string; employee_role: string; workflow_id: string | null; run_id: string | null;
  action_type: string; decision: LedgerDecision; reason_code: string; confidence: number; prompt_version: string | null;
}
export interface MetricRawCounts {
  executed: number; escalated: number; suppressed: number; declined: number; deferred: number;
  totalActions: number; decidedPendingMs: number[]; expiredPending: number; totalPending: number;
  obligations: number; messages: number; groundingRejected: number; groundingChecked: number;
  openDiscrepancies: number; discrepancyZeroStreakDays: number;
  /** Max sends to one customer today; null = no budget rows (no data), never fake-healthy 0. */
  outboundPerCustomer: number | null;
  outboundCap: number; predictedMinusActual: number | null; isWorkingDay: boolean;
}
const LABELS: Record<SilentMetricKey, string> = {
  approval_rate: 'Approval rate', escalation_rate: 'Escalation rate', time_to_decision: 'Time-to-decision p50',
  obligations_per_100: 'Obligations per 100 messages', grounding_rejection_rate: 'Grounding rejection rate',
  open_discrepancies: 'Open discrepancies', autonomous_action_share: 'Autonomous action share',
  suppression_rate: 'Suppression rate', outbound_per_customer: 'Outbound per customer',
  confidence_calibration_drift: 'Confidence calibration drift',
};
function ratio(n: number, d: number): number | null { return d <= 0 ? null : n / d; }
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
function band(key: SilentMetricKey, value: number | null, unit: string, healthyLow: number | null, healthyHigh: number | null, status: BandStatus, alertReason: string | null): SilentMetric {
  return { key, label: LABELS[key], value, unit, healthyLow, healthyHigh, status, alertReason };
}
export function computeSilentMetrics(raw: MetricRawCounts): SilentMetric[] {
  const totalDecided = raw.executed + raw.escalated + raw.suppressed + raw.declined + raw.deferred;
  const approval = ratio(raw.executed, raw.escalated);
  const escalation = ratio(raw.escalated, raw.totalActions);
  const p50 = percentile([...raw.decidedPendingMs].sort((a, b) => a - b), 50);
  const p50h = p50 == null ? null : p50 / 3_600_000;
  const expiry = ratio(raw.expiredPending, raw.totalPending);
  const obligations = raw.messages <= 0 ? null : (raw.obligations / raw.messages) * 100;
  const grounding = ratio(raw.groundingRejected, raw.groundingChecked);
  const autonomous = ratio(raw.executed, totalDecided);
  const suppression = ratio(raw.suppressed, totalDecided);
  const drift = raw.predictedMinusActual == null ? null : Math.abs(raw.predictedMinusActual);
  const outbound = raw.outboundPerCustomer;
  const outboundStatus: BandStatus =
    outbound == null ? 'unknown' : outbound > raw.outboundCap ? 'alert' : 'healthy';
  const approvalStatus: BandStatus = approval == null ? 'unknown' : approval >= 0.6 && approval <= 0.9 ? 'healthy' : 'alert';
  let ttdStatus: BandStatus = p50h == null ? 'unknown' : p50h < 4 ? 'healthy' : 'alert';
  let ttdReason: string | null = p50h != null && p50h > 24 ? 'Nobody is reading the queue' : null;
  if (expiry != null && expiry > 0.1) { ttdStatus = 'alert'; ttdReason = 'Expiry rate above 10% — queue is being ignored'; }
  let discStatus: BandStatus = 'healthy';
  let discReason: string | null = null;
  if (raw.isWorkingDay && raw.discrepancyZeroStreakDays >= 3) { discStatus = 'alert'; discReason = 'Dead detector — zero discrepancies for 3 working days'; }
  else if (raw.isWorkingDay && raw.openDiscrepancies === 0) { discStatus = 'alert'; discReason = 'Zero discrepancies on a working day'; }
  return [
    band('approval_rate', approval, 'ratio', 0.6, 0.9, approvalStatus, approval == null ? null : approval > 0.9 ? 'Fatigue collapse — almost everything is approved unread' : approval < 0.6 ? 'Garbage escalations — owners are rejecting most cards' : null),
    band('escalation_rate', escalation, 'ratio', 0.05, 0.25, escalation == null ? 'unknown' : escalation > 0.25 || escalation < 0.02 ? 'alert' : 'healthy', escalation == null ? null : escalation > 0.25 ? 'Over-asking' : escalation < 0.02 ? 'Gate stopped gating' : null),
    band('time_to_decision', p50h, 'hours', null, 4, ttdStatus, ttdReason),
    band('obligations_per_100', obligations, 'count', 8, 25, obligations == null ? 'unknown' : obligations === 0 || obligations > 40 ? 'alert' : 'healthy', obligations === 0 ? 'Extractor died — zero obligations' : obligations != null && obligations > 40 ? 'Extractor hallucinating' : null),
    band('grounding_rejection_rate', grounding, 'ratio', 0.01, 0.15, grounding == null ? 'unknown' : grounding === 0 || grounding > 0.3 ? 'alert' : 'healthy', grounding === 0 ? 'Grounding check not running' : grounding != null && grounding > 0.3 ? 'Prompt regression' : null),
    band('open_discrepancies', raw.openDiscrepancies, 'count', 1, null, discStatus, discReason),
    band('autonomous_action_share', autonomous, 'ratio', null, null, autonomous == null ? 'unknown' : 'healthy', null),
    band('suppression_rate', suppression, 'ratio', null, 0.7, suppression == null ? 'unknown' : suppression > 0.7 ? 'alert' : 'healthy', suppression != null && suppression > 0.7 ? 'Learned silence' : null),
    band('outbound_per_customer', outbound, 'count', null, raw.outboundCap, outboundStatus, outbound != null && outbound > raw.outboundCap ? 'Cross-employee spam cap breached' : null),
    band('confidence_calibration_drift', drift, 'abs', null, 0.1, drift == null ? 'unknown' : drift > 0.15 ? 'alert' : 'healthy', drift != null && drift > 0.15 ? 'Confidence has become noise' : null),
  ];
}
export function stripPiiFromLog(input: Record<string, unknown>): StructuredDecisionLog {
  const allowed: LedgerDecision[] = ['executed', 'deferred', 'declined', 'escalated', 'suppressed'];
  return {
    org_id: String(input.org_id || ''), employee_role: String(input.employee_role || ''),
    workflow_id: input.workflow_id == null ? null : String(input.workflow_id),
    run_id: input.run_id == null ? null : String(input.run_id),
    action_type: String(input.action_type || input.action_considered || ''),
    decision: allowed.includes(input.decision as LedgerDecision) ? (input.decision as LedgerDecision) : 'declined',
    reason_code: String(input.reason_code || ''),
    confidence: Number(input.confidence ?? input.confidence_score ?? 0),
    prompt_version: input.prompt_version == null ? null : String(input.prompt_version),
  };
}
