import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { DecisionCard, OwnerDecisionCard, type DecisionCardPayload } from '../DecisionCard';

const payload: DecisionCardPayload = {
  title: 'Refund request — Sarah Chen',
  customer: 'Sarah Chen, Acme Ltd',
  situation: 'Order arrived 6 days late. She asked for a full refund (€1,240).',
  options: [
    { id: 'full', label: 'Full refund €1,240', cost: 'she stays, margin gone this quarter' },
    { id: 'partial', label: 'Refund shipping + 20% off', cost: '~€380, offered this twice before' },
  ],
  recommendation: {
    optionId: 'partial',
    basis: 'Matches what you approved for Kellerman (Aug) and Voss (Jun)',
  },
};

describe('OwnerDecisionCard', () => {
  it('renders at least two options with costs', () => {
    render(<OwnerDecisionCard workItemId="wi-d" payload={payload} />);
    expect(screen.getAllByText('Full refund €1,240').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('she stays, margin gone this quarter')).toBeInTheDocument();
    expect(screen.getAllByText('Refund shipping + 20% off').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('~€380, offered this twice before')).toBeInTheDocument();
  });

  it('shows the recommendation basis', () => {
    render(<OwnerDecisionCard payload={payload} />);
    expect(screen.getByText(/Recommended:/)).toBeInTheDocument();
    expect(
      screen.getByText('Matches what you approved for Kellerman (Aug) and Voss (Jun)')
    ).toBeInTheDocument();
  });

  it('has Do this and Not now', () => {
    render(<OwnerDecisionCard payload={payload} />);
    expect(screen.getByText('Do this')).toBeInTheDocument();
    expect(screen.getByText('Not now')).toBeInTheDocument();
  });

  it('shows four rejection reasons', () => {
    render(<OwnerDecisionCard payload={payload} />);
    fireEvent.click(screen.getByText('Not this one'));
    expect(screen.getByText('Wrong fit')).toBeInTheDocument();
    expect(screen.getByText('Wrong timing')).toBeInTheDocument();
    expect(screen.getByText('Wrong channel')).toBeInTheDocument();
    expect(screen.getByText('Just not now')).toBeInTheDocument();
  });

  it('exports DecisionCard as the same surface', () => {
    render(<DecisionCard payload={payload} />);
    expect(screen.getByText('Do this')).toBeInTheDocument();
  });
});
