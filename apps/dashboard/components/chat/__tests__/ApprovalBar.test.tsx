import React from 'react';
import { render, screen } from '@testing-library/react';
jest.mock('@/lib/nango-client', () => ({ startRealNangoOAuth: jest.fn(), disconnectProvider: jest.fn() }));

import { ApprovalBar } from '../AgentTrajectory';

const noop = () => undefined;
const request = {
  summary: 'Send email "Saturday showing" to priya@example.test',
  call: { tool: 'gmail', action: 'send_email', args: { to: 'priya@example.test', subject: 'Saturday showing', body: 'Hi Priya, your showing is confirmed for Saturday 11am.' } },
};

// Allowing a call in the chat IS the approval, so the card has to show what is being approved.
describe('ApprovalBar', () => {
  it('shows what the person is about to allow: what it does, to whom, and what it says', () => {
    render(<ApprovalBar toolName="gmail_send" request={request} onAllow={noop} onDeny={noop} />);
    expect(screen.getByText('Send email "Saturday showing" to priya@example.test')).toBeInTheDocument();
    expect(screen.getByText('priya@example.test', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Hi Priya, your showing is confirmed for Saturday 11am.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Approve/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Deny/ })).toBeInTheDocument();
  });

  it('does not lead with an internal tool name when it can say what the call does', () => {
    render(<ApprovalBar toolName="gmail_send" request={request} onAllow={noop} onDeny={noop} />);
    expect(screen.queryByText('gmail_send')).toBeNull();
    expect(screen.getByText(/Needs your OK/)).toBeInTheDocument();
  });

  it('falls back to the tool name when the call could not be read, as before', () => {
    render(<ApprovalBar toolName="gmail_send" onAllow={noop} onDeny={noop} />);
    expect(screen.getByText(/Tool Approval Required for/)).toBeInTheDocument();
    expect(screen.getByText('gmail_send')).toBeInTheDocument();
  });

  it('still says what was decided afterwards', () => {
    const { rerender } = render(<ApprovalBar toolName="gmail_send" request={request} decided="allow" onAllow={noop} onDeny={noop} />);
    expect(screen.getByText(/Tool Approved/)).toBeInTheDocument();
    rerender(<ApprovalBar toolName="gmail_send" request={request} decided="deny" onAllow={noop} onDeny={noop} />);
    expect(screen.getByText(/Tool Approval Denied/)).toBeInTheDocument();
  });
});
