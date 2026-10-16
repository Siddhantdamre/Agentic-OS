import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OpportunityCard, type GrowthOpportunityPayload } from '../OpportunityCard';

const payload: GrowthOpportunityPayload = {
  companyName: 'NovaTech',
  whyThisCompany: 'Matches closed-won accounts.',
  targetContact: { name: 'Priya Shah', title: 'VP Ops' },
  whyThisPerson: 'Owns vendor decisions.',
  whyNow: 'Visited pricing three times.',
  draftedMessage: { subject: 'Quick intro', body: 'Saw you looking at pricing…' },
};

/** A decision that fails to save must be said out loud, and must leave the card open so it can be retried. */
describe('OpportunityCard when saving a decision fails', () => {
  it('shows a plain sentence for a dropped connection and keeps the card usable', async () => {
    const onDecision = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    render(<OpportunityCard workItemId="wi-1" payload={payload} onDecision={onDecision} />);
    fireEvent.click(screen.getByText('Send'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/connection|try again/i);
    expect(alert.textContent).not.toMatch(/Failed to fetch|TypeError/);
    expect(screen.getByText('Send')).toBeInTheDocument();
    expect(screen.queryByText('Queued to send')).not.toBeInTheDocument();
  });

  it('shows the server’s own sentence when it sent one, and clears it on the next try', async () => {
    const onDecision = jest.fn().mockRejectedValueOnce(new Error('This opportunity was already handled.')).mockResolvedValueOnce(undefined);
    render(<OpportunityCard workItemId="wi-1" payload={payload} onDecision={onDecision} />);
    fireEvent.click(screen.getByText('Send'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already handled/i);
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(screen.getByText('Queued to send')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
