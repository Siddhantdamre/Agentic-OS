/**
 * @jest-environment node
 */
import { resolveLockedHandoff } from '../handoffs/index';

describe('executive and research hand-offs', () => {
  it('Executive hands email triage to Customer Support', () => {
    const hit = resolveLockedHandoff(['Executive'], 'fetch my recent emails and summarize inbox');
    expect(hit).not.toBeNull();
    expect(hit!.toRole).toBe('Customer Support');
    expect(hit!.reason).toMatch(/email/i);
  });

  it('Executive hands refunds to Customer', () => {
    const hit = resolveLockedHandoff(['Executive'], 'Process a refund for order 123');
    expect(hit).not.toBeNull();
    expect(hit!.toRole).toBe('Customer');
    expect(hit!.reason).toMatch(/refund/i);
  });

  it('Executive hands spreadsheets to Operations', () => {
    const hit = resolveLockedHandoff(['Executive'], 'Reconcile the Google Sheet data');
    expect(hit).not.toBeNull();
    expect(hit!.toRole).toBe('Operations');
  });

  it('Executive hands payment links to Finance', () => {
    const hit = resolveLockedHandoff(['Executive'], 'Generate a payment link for this invoice');
    expect(hit).not.toBeNull();
    expect(hit!.toRole).toBe('Finance');
  });
});
