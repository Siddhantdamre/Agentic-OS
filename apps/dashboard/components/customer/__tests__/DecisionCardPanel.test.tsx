import React from 'react';
import { render, screen } from '@testing-library/react';
import { DecisionCardPanel, type CustomerDecisionCard } from '../DecisionCardPanel';

// This is exactly what the server stores for a held action (buildDecisionCard + heldActionCard).
const heldEmail = {
  kind: 'decision_card',
  actionType: 'external_send',
  title: 'Send email "About your enquiry" to priya@example.test',
  summary: 'Send email "About your enquiry" to priya@example.test',
  reasonCode: 'confirm_class',
  options: [
    { id: 'approve', label: 'Approve and run', cost: 'the proposed action executes' },
    { id: 'reject', label: 'Reject', cost: 'no change; logged as declined' },
  ],
  recommendation: { optionId: 'approve', basis: 'confirm_class' },
  payload: { tool: 'gmail', action: 'send_email', payload: { to: 'priya@example.test', subject: 'About your enquiry', body: 'Hi Priya, the flat is free on Saturday.' } },
} as unknown as CustomerDecisionCard;

describe('DecisionCardPanel', () => {
  it('does not crash on a held action: the recommendation arrives as an object, not text', () => {
    // React error 31 ("Objects are not valid as a React child") took the whole Customer tab down.
    expect(() => render(<DecisionCardPanel workItemId="wi-1" card={heldEmail} />)).not.toThrow();
  });

  it('says what it would do, shows the message, and recommends an option in words', () => {
    render(<DecisionCardPanel workItemId="wi-1" card={heldEmail} />);
    expect(screen.getByRole('heading', { name: 'Send email "About your enquiry" to priya@example.test' })).toBeInTheDocument();
    expect(screen.getByText('Hi Priya, the flat is free on Saturday.')).toBeInTheDocument();
    expect(screen.getByText(/Recommended: Approve and run/)).toBeInTheDocument();
    expect(screen.getByText('Sending a message to a customer always needs your OK.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve and run/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reject/ })).toBeInTheDocument();
  });

  it('still renders the older card shape, where the recommendation is plain text', () => {
    render(<DecisionCardPanel workItemId="wi-2" card={{ title: 'Refund request', situation: 'Late delivery', recommendation: 'Partial credit' }} />);
    expect(screen.getByText('Refund request')).toBeInTheDocument();
    expect(screen.getByText(/Recommended: Partial credit/)).toBeInTheDocument();
  });

  it('never prints "[object Object]" for a recommendation it cannot read', () => {
    const { container } = render(<DecisionCardPanel workItemId="wi-3" card={{ title: 'x', recommendation: { weird: true } as unknown as string }} />);
    expect(container.textContent).not.toMatch(/\[object Object\]/);
  });
});
