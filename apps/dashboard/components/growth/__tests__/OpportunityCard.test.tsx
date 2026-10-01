import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { OpportunityCard, type GrowthOpportunityPayload } from '../OpportunityCard';

const payload: GrowthOpportunityPayload = {
  companyName: 'NovaTech',
  icpScore: 86,
  whyThisCompany: 'Matches closed-won accounts in industrial SaaS.',
  targetContact: { name: 'Priya Shah', title: 'VP Ops' },
  whyThisPerson: 'Owns vendor decisions for the ops stack.',
  whyNow: 'Pricing page visited three times this morning.',
  draftedMessage: { subject: 'Quick intro', body: 'Saw you looking at pricing…' },
};

describe('OpportunityCard', () => {
  it('renders why this company, person, and now', () => {
    render(<OpportunityCard workItemId="wi-1" payload={payload} />);
    expect(screen.getByText('Why this company')).toBeInTheDocument();
    expect(screen.getByText(payload.whyThisCompany as string)).toBeInTheDocument();
    expect(screen.getByText('Why this person')).toBeInTheDocument();
    expect(screen.getByText(payload.whyThisPerson as string)).toBeInTheDocument();
    expect(screen.getByText('Why now')).toBeInTheDocument();
    expect(screen.getByText(payload.whyNow)).toBeInTheDocument();
  });

  it('has Send, Not this one, and Not now', () => {
    render(<OpportunityCard workItemId="wi-1" payload={payload} />);
    expect(screen.getByText('Send')).toBeInTheDocument();
    expect(screen.getByText('Not this one')).toBeInTheDocument();
    expect(screen.getByText('Not now')).toBeInTheDocument();
  });

  it('shows four rejection reasons after Not this one', () => {
    const onDecision = jest.fn();
    render(<OpportunityCard workItemId="wi-1" payload={payload} onDecision={onDecision} />);
    fireEvent.click(screen.getByText('Not this one'));
    expect(screen.getByText('Wrong fit')).toBeInTheDocument();
    expect(screen.getByText('Wrong timing')).toBeInTheDocument();
    expect(screen.getByText('Wrong channel')).toBeInTheDocument();
    expect(screen.getByText('Just not now')).toBeInTheDocument();
  });
});
