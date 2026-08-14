import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ActionPermissionCard, ProposedActionData } from '../ActionPermissionCard';

describe('ActionPermissionCard', () => {
  const mockAction: ProposedActionData = {
    tool: 'gmail',
    action: 'send_email',
    params: {
      to: 'test@example.com',
      subject: 'Test Email',
      body: 'This is a test email',
    },
    explanation: 'Send an email to test user',
  };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders action details in pending state', () => {
    render(<ActionPermissionCard actionData={mockAction} />);

    expect(screen.getByText(/Gmail Integration/i)).toBeInTheDocument();
    expect(screen.getByText('Authorization Required')).toBeInTheDocument();
    expect(screen.getByText(mockAction.explanation)).toBeInTheDocument();
    expect(screen.getByText('send_email')).toBeInTheDocument();
  });

  it('displays all parameters', () => {
    render(<ActionPermissionCard actionData={mockAction} />);

    expect(screen.getByText('to')).toBeInTheDocument();
    expect(screen.getByText('subject')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('handles approve action', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, result: { status: 'executed', message: 'Email sent' } }),
    });

    const onComplete = jest.fn();
    render(<ActionPermissionCard actionData={mockAction} onExecutionComplete={onComplete} />);

    const approveBtn = screen.getByText(/Approve & Execute/i);
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(screen.getByText('Executed')).toBeInTheDocument();
    });

    expect(onComplete).toHaveBeenCalled();
  });

  it('handles cancel action', () => {
    render(<ActionPermissionCard actionData={mockAction} />);

    const denyBtn = screen.getByText('Deny');
    fireEvent.click(denyBtn);

    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('handles failed execution response', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: false, error: 'Connection failed' }),
    });

    render(<ActionPermissionCard actionData={mockAction} />);

    const approveBtn = screen.getByText(/Approve & Execute/i);
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(screen.getByText(/Approve & Execute/i)).toBeInTheDocument();
    });
  });

  it('shows appropriate icon for different tools', () => {
    const tools = ['gmail', 'whatsapp', 'stripe', 'unknown-tool'];

    tools.forEach((tool) => {
      const { unmount } = render(
        <ActionPermissionCard actionData={{ ...mockAction, tool }} />
      );
      const toolName = tool.replace('-', ' ');
      expect(screen.getByText(new RegExp(`${toolName}.*integration`, 'i'))).toBeInTheDocument();
      unmount();
    });
  });

  it('handles not_connected status', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, result: { status: 'not_connected', message: 'Not connected' } }),
    });

    render(<ActionPermissionCard actionData={mockAction} />);

    const approveBtn = screen.getByText(/Approve & Execute/i);
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(screen.getByText(/is not connected/i)).toBeInTheDocument();
      expect(screen.getByText('Configure Integration')).toBeInTheDocument();
    });
  });
});
