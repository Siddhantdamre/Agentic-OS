import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlanCard } from '../PlanCard';
import type { PlanStep } from '@darex/shared-types';

describe('PlanCard', () => {
  const mockSteps: PlanStep[] = [
    { id: '1', description: 'Check email', action: 'check', tool: 'email', enabled: true },
    { id: '2', description: 'Send response', action: 'send', tool: 'email', enabled: true },
    { id: '3', description: 'Update CRM', action: 'update', tool: 'crm', enabled: false },
  ];

  it('renders plan title and summary', () => {
    render(
      <PlanCard
        planId="plan-1"
        summary="This is a test plan"
        steps={mockSteps}
        onApprove={jest.fn()}
        onCancel={jest.fn()}
        onToggleStep={jest.fn()}
      />
    );

    expect(screen.getByText('Execution Plan')).toBeInTheDocument();
    expect(screen.getByText('This is a test plan')).toBeInTheDocument();
  });

  it('renders all steps', () => {
    render(
      <PlanCard
        planId="plan-1"
        summary="Test"
        steps={mockSteps}
        onApprove={jest.fn()}
        onCancel={jest.fn()}
        onToggleStep={jest.fn()}
      />
    );

    mockSteps.forEach((step) => {
      expect(screen.getByText(step.description)).toBeInTheDocument();
    });
  });

  it('handles step toggle', () => {
    const onToggleStep = jest.fn();
    render(
      <PlanCard
        planId="plan-1"
        summary="Test"
        steps={mockSteps}
        onApprove={jest.fn()}
        onCancel={jest.fn()}
        onToggleStep={onToggleStep}
      />
    );

    const toggleButtons = screen.getAllByRole('button', { name: 'toggle step' });
    fireEvent.click(toggleButtons[0]);

    expect(onToggleStep).toHaveBeenCalledWith('plan-1', 0, false);
  });

  it('shows skipped state for disabled steps', () => {
    render(
      <PlanCard
        planId="plan-1"
        summary="Test"
        steps={mockSteps}
        onApprove={jest.fn()}
        onCancel={jest.fn()}
        onToggleStep={jest.fn()}
      />
    );

    expect(screen.getByText('Skipped')).toBeInTheDocument();
  });

  it('handles approve action', () => {
    const onApprove = jest.fn();
    render(
      <PlanCard
        planId="plan-1"
        summary="Test"
        steps={mockSteps}
        onApprove={onApprove}
        onCancel={jest.fn()}
        onToggleStep={jest.fn()}
      />
    );

    const approveBtn = screen.getByText(/Approve & Execute/);
    fireEvent.click(approveBtn);

    expect(onApprove).toHaveBeenCalledWith('plan-1');
  });

  it('handles cancel action', () => {
    const onCancel = jest.fn();
    render(
      <PlanCard
        planId="plan-1"
        summary="Test"
        steps={mockSteps}
        onApprove={jest.fn()}
        onCancel={onCancel}
        onToggleStep={jest.fn()}
      />
    );

    const cancelBtn = screen.getByText('Cancel');
    fireEvent.click(cancelBtn);

    expect(onCancel).toHaveBeenCalledWith('plan-1');
  });

  it('handles add instruction', () => {
    const onAddInstruction = jest.fn();
    render(
      <PlanCard
        planId="plan-1"
        summary="Test"
        steps={mockSteps}
        onApprove={jest.fn()}
        onCancel={jest.fn()}
        onToggleStep={jest.fn()}
        onAddInstruction={onAddInstruction}
      />
    );

    const input = screen.getByPlaceholderText(/Add an instruction/);
    fireEvent.change(input, { target: { value: 'Do not modify data' } });

    const addBtn = screen.getByText('Add');
    fireEvent.click(addBtn);

    expect(onAddInstruction).toHaveBeenCalledWith('plan-1', 'Do not modify data');
  });

  it('disables add button when input is empty', () => {
    render(
      <PlanCard
        planId="plan-1"
        summary="Test"
        steps={mockSteps}
        onApprove={jest.fn()}
        onCancel={jest.fn()}
        onToggleStep={jest.fn()}
        onAddInstruction={jest.fn()}
      />
    );

    const input = screen.getByPlaceholderText(/Add an instruction/);
    expect(input).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '' } });
    const addBtn = screen.queryByText('Add');
    expect(addBtn).not.toBeInTheDocument();
  });

  it('disables all actions when disabled prop is true', () => {
    const { container } = render(
      <PlanCard
        planId="plan-1"
        summary="Test"
        steps={mockSteps}
        disabled
        onApprove={jest.fn()}
        onCancel={jest.fn()}
        onToggleStep={jest.fn()}
      />
    );

    const buttons = container.querySelectorAll('button');
    buttons.forEach((btn) => {
      expect(btn.hasAttribute('disabled')).toBe(true);
    });
  });

  it('pads step numbers', () => {
    render(
      <PlanCard
        planId="plan-1"
        summary="Test"
        steps={mockSteps}
        onApprove={jest.fn()}
        onCancel={jest.fn()}
        onToggleStep={jest.fn()}
      />
    );

    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('02')).toBeInTheDocument();
    expect(screen.getByText('03')).toBeInTheDocument();
  });
});
