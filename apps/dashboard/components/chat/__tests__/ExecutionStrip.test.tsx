import React from 'react';
import { render, screen } from '@testing-library/react';
import { ExecutionStrip, StepRunStatus } from '../ExecutionStrip';

describe('ExecutionStrip', () => {
  const mockSteps = [
    { id: '1', description: 'Send email to customer' },
    { id: '2', description: 'Log the activity' },
    { id: '3', description: 'Update database' },
  ];

  it('renders all steps', () => {
    const statuses: StepRunStatus[] = [
      { status: 'done' },
      { status: 'pending' },
      { status: 'pending' },
    ];

    render(<ExecutionStrip steps={mockSteps} statuses={statuses} running={false} />);

    mockSteps.forEach((step) => {
      expect(screen.getByText(step.description)).toBeInTheDocument();
    });
  });

  it('shows progress percentage', () => {
    const statuses: StepRunStatus[] = [
      { status: 'done' },
      { status: 'done' },
      { status: 'pending' },
    ];

    render(<ExecutionStrip steps={mockSteps} statuses={statuses} running={false} />);

    expect(screen.getByText('67%')).toBeInTheDocument();
  });

  it('shows running state when active', () => {
    const statuses: StepRunStatus[] = [
      { status: 'done' },
      { status: 'running' },
      { status: 'pending' },
    ];

    render(<ExecutionStrip steps={mockSteps} statuses={statuses} running={true} />);

    expect(screen.getByText(/Executing step 2 of 3/)).toBeInTheDocument();
  });

  it('shows completion message', () => {
    const statuses: StepRunStatus[] = [
      { status: 'done' },
      { status: 'done' },
      { status: 'done' },
    ];

    render(<ExecutionStrip steps={mockSteps} statuses={statuses} running={false} />);

    expect(screen.getByText('Execution completed successfully')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('shows error state when steps fail', () => {
    const statuses: StepRunStatus[] = [
      { status: 'done' },
      { status: 'error', message: 'Email service unavailable' },
      { status: 'pending' },
    ];

    render(<ExecutionStrip steps={mockSteps} statuses={statuses} running={false} />);

    expect(screen.getByText('Execution finished with errors')).toBeInTheDocument();
    expect(screen.getByText('Email service unavailable')).toBeInTheDocument();
  });

  it('shows setup link for error steps', () => {
    const statuses: StepRunStatus[] = [
      { status: 'error', message: 'Tool not configured', setupUrl: '/connectors/email' },
    ];

    render(<ExecutionStrip steps={[mockSteps[0]]} statuses={statuses} running={false} />);

    const link = screen.getByText('Connect this tool') as HTMLAnchorElement;
    expect(link.href).toContain('/connectors/email');
  });

  it('handles skipped steps', () => {
    const statuses: StepRunStatus[] = [
      { status: 'done' },
      { status: 'skipped' },
      { status: 'done' },
    ];

    render(<ExecutionStrip steps={mockSteps} statuses={statuses} running={false} />);

    expect(screen.getByText('Skipped')).toBeInTheDocument();
  });

  it('marks pending steps correctly', () => {
    const statuses: StepRunStatus[] = [
      { status: 'pending' },
      { status: 'pending' },
      { status: 'pending' },
    ];

    render(<ExecutionStrip steps={mockSteps} statuses={statuses} running={false} />);

    const pendingElements = screen.getAllByText('Pending');
    expect(pendingElements.length).toBeGreaterThan(0);
  });

  it('handles empty steps gracefully', () => {
    const statuses: StepRunStatus[] = [];

    render(<ExecutionStrip steps={[]} statuses={statuses} running={false} />);

    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('pads step numbers with zeros', () => {
    const statuses: StepRunStatus[] = Array(10).fill({ status: 'pending' });
    const steps = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      description: `Step ${i + 1}`,
    }));

    render(<ExecutionStrip steps={steps} statuses={statuses} running={false} />);

    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
  });
});
