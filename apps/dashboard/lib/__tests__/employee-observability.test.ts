import { computeSilentMetrics, stripPiiFromLog } from '../employee-observability';
describe('computeSilentMetrics', () => {
  it('alerts when approval rate is 100% — fatigue collapse', () => {
    const metrics = computeSilentMetrics({
      executed: 40, escalated: 10, suppressed: 0, declined: 0, deferred: 0, totalActions: 50,
      decidedPendingMs: [3_600_000], expiredPending: 0, totalPending: 10, obligations: 12, messages: 100,
      groundingRejected: 5, groundingChecked: 50, openDiscrepancies: 2, discrepancyZeroStreakDays: 0,
      outboundPerCustomer: 1, outboundCap: 8, predictedMinusActual: 0.02, isWorkingDay: true,
    });
    expect(metrics.find((m) => m.key === 'approval_rate')?.status).toBe('alert');
  });
  it('alerts on zero obligations', () => {
    const metrics = computeSilentMetrics({
      executed: 8, escalated: 10, suppressed: 1, declined: 1, deferred: 0, totalActions: 40,
      decidedPendingMs: [1_000_000], expiredPending: 0, totalPending: 4, obligations: 0, messages: 80,
      groundingRejected: 2, groundingChecked: 20, openDiscrepancies: 1, discrepancyZeroStreakDays: 0,
      outboundPerCustomer: 1, outboundCap: 8, predictedMinusActual: 0.01, isWorkingDay: true,
    });
    expect(metrics.find((m) => m.key === 'obligations_per_100')?.status).toBe('alert');
  });
  it('strips message bodies from structured logs', () => {
    const log = stripPiiFromLog({ org_id: 'o1', employee_role: 'customer', action_type: 'send_email', decision: 'escalated', reason_code: 'low_confidence', confidence: 0.4, content: 'SECRET customer email' });
    expect(JSON.stringify(log)).not.toContain('SECRET');
  });
  it('does not treat missing outbound as healthy zero', () => {
    const metrics = computeSilentMetrics({
      executed: 8, escalated: 10, suppressed: 1, declined: 1, deferred: 0, totalActions: 40,
      decidedPendingMs: [1_000_000], expiredPending: 0, totalPending: 4, obligations: 12, messages: 80,
      groundingRejected: 2, groundingChecked: 20, openDiscrepancies: 1, discrepancyZeroStreakDays: 0,
      outboundPerCustomer: null, outboundCap: 8, predictedMinusActual: null, isWorkingDay: true,
    });
    expect(metrics.find((m) => m.key === 'outbound_per_customer')?.status).toBe('unknown');
    expect(metrics.find((m) => m.key === 'confidence_calibration_drift')?.status).toBe('unknown');
  });
});
