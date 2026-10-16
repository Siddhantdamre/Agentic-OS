import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

jest.mock('@/lib/use-live-refresh', () => ({ useLiveRefresh: () => undefined }));

import { AgentHealthPanel } from '../AgentHealthPanel';

const snapshot = {
  asOf: '2026-10-16T12:00:00Z',
  summary: { stuck: 1, watch: 1, ok: 1, new: 0, paused: 0 },
  notes: [{ level: 'watch', text: '2 customer messages failed to arrive and are waiting for a retry.' }],
  employees: [
    { id: 'a', name: 'Maya', role: 'Customer Support', employeeStatus: 'active', status: 'stuck', reasons: ['2 approvals are waiting; the oldest for 3 days. Nothing happens until you decide.'], lastActionAt: '2026-10-15T12:00:00Z', waiting: 2, oldestWaitingHours: 72, decided: 12, approvedAsIs: 9, approvedEdited: 2, rejected: 1, failedToRun: 0 },
    { id: 'b', name: 'Ravi', role: 'Growth', employeeStatus: 'active', status: 'watch', reasons: ['It has not done anything yet.'], lastActionAt: null, waiting: 0, oldestWaitingHours: null, decided: 0, approvedAsIs: 0, approvedEdited: 0, rejected: 0, failedToRun: 0 },
    { id: 'c', name: 'Asha', role: 'Operations', employeeStatus: 'active', status: 'ok', reasons: [], lastActionAt: '2026-10-16T09:00:00Z', waiting: 0, oldestWaitingHours: null, decided: 20, approvedAsIs: 18, approvedEdited: 1, rejected: 1, failedToRun: 0 },
  ],
};

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

describe('AgentHealthPanel', () => {
  afterEach(() => { (global as any).fetch = undefined; });

  it('lists each employee with a status in words and the reason, most urgent first', async () => {
    (global as any).fetch = jest.fn(() => ok(snapshot));
    render(<AgentHealthPanel />);
    await waitFor(() => expect(screen.getByText('Maya')).toBeTruthy());
    const names = screen.getAllByTestId('agent-name').map((n) => n.textContent);
    expect(names).toEqual(['Maya', 'Ravi', 'Asha']);
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('Keep an eye on it')).toBeTruthy();
    expect(screen.getByText('Working well')).toBeTruthy();
    expect(screen.getByText(/2 approvals are waiting; the oldest for 3 days/)).toBeTruthy();
    expect(screen.getByText(/It has not done anything yet/)).toBeTruthy();
  });

  it('shows workspace notes such as failed customer messages', async () => {
    (global as any).fetch = jest.fn(() => ok(snapshot));
    render(<AgentHealthPanel />);
    await waitFor(() => expect(screen.getByText(/2 customer messages failed to arrive/)).toBeTruthy());
  });

  it('says what it knows about the last activity in plain words', async () => {
    (global as any).fetch = jest.fn(() => ok(snapshot));
    render(<AgentHealthPanel now={new Date('2026-10-16T12:00:00Z')} />);
    await waitFor(() => expect(screen.getByText('Maya')).toBeTruthy());
    expect(screen.getByText(/Last active 1 day ago/)).toBeTruthy();
    expect(screen.getByText(/Has not acted yet/)).toBeTruthy();
    expect(screen.getByText(/2 waiting/)).toBeTruthy();
  });

  it('says so when it cannot load, never that all is well', async () => {
    (global as any).fetch = jest.fn(() => Promise.reject(new Error('Failed to fetch')));
    render(<AgentHealthPanel />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/isn.t available/i);
    expect(screen.queryByText('Working well')).toBeNull();
  });

  it('treats a reply that is not a team overview as a failure, not as an empty team', async () => {
    (global as any).fetch = jest.fn(() => ok({ metrics: [], alertCount: 2 }));
    render(<AgentHealthPanel />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText(/No AI employees yet/i)).toBeNull();
  });

  it('says so when there are no employees yet', async () => {
    (global as any).fetch = jest.fn(() => ok({ ...snapshot, employees: [], notes: [], summary: { stuck: 0, watch: 0, ok: 0, new: 0, paused: 0 } }));
    render(<AgentHealthPanel />);
    await waitFor(() => expect(screen.getByText(/No AI employees yet/i)).toBeTruthy());
  });
});
