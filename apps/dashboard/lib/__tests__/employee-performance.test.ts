import { buildEmployeePerformance, loadEmployeePerformance } from '../employee-performance';

describe('employee performance', () => {
  it('computes rates and rounds resolution hours', () => {
    const p = buildEmployeePerformance('e1', { total: '10', open: '3', completed: '6', cancelled: '1', completed_7d: '2', avg_resolution_hours: '4.26' });
    expect(p).toMatchObject({ totalAssigned: 10, open: 3, completed: 6, completedLast7d: 2, avgResolutionHours: 4.3, completionRate: 0.857 });
  });

  it('returns null (not 0) when nothing has finished', () => {
    const p = buildEmployeePerformance('e1', { total: '2', open: '2', completed: '0', cancelled: '0', completed_7d: '0', avg_resolution_hours: null });
    expect(p.completionRate).toBeNull();
    expect(p.avgResolutionHours).toBeNull();
  });

  it('keys the query on org and employee uuid', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ total: '1', open: '1', completed: '0', cancelled: '0', completed_7d: '0', avg_resolution_hours: null }] });
    await loadEmployeePerformance({ query } as never, 'org-1', 'emp-1');
    expect(query.mock.calls[0][1]).toEqual(['org-1', 'emp-1']);
    expect(query.mock.calls[0][0]).toContain('assignee_employee_id = $2');
  });

  it('degrades to empty metrics when the table is missing', async () => {
    const query = jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: '42P01' }));
    const p = await loadEmployeePerformance({ query } as never, 'o', 'e');
    expect(p.totalAssigned).toBe(0);
  });

  it('computes approval rate from per-employee ledger verdicts', () => {
    const p = buildEmployeePerformance('e1', undefined, { executed: '6', declined: '1', escalated: '1' });
    expect(p.approvalRate).toBe(0.75);
    expect(p.approvalSample).toBe(8);
  });

  it('returns null approval rate (not 0) with no ledger history', () => {
    expect(buildEmployeePerformance('e1', undefined, { executed: '0', declined: '0', escalated: '0' }).approvalRate).toBeNull();
    expect(buildEmployeePerformance('e1', undefined).approvalRate).toBeNull();
  });

  it('queries the ledger by employee_id and tolerates a missing column', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockRejectedValueOnce(Object.assign(new Error('x'), { code: '42703' }));
    const p = await loadEmployeePerformance({ query } as never, 'org-1', 'emp-1');
    expect(query.mock.calls[1][0]).toContain('employee_id = $2');
    expect(query.mock.calls[1][1]).toEqual(['org-1', 'emp-1']);
    expect(p.approvalRate).toBeNull();
  });
});
