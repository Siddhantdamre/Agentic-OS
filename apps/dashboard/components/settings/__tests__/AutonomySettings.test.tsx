import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AutonomySettings } from '../AutonomySettings';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
  } as Response);
}

describe('AutonomySettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('PATCHes autonomy tier and removes pending rows on approve/reject', async () => {
    const fetchMock = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === '/api/settings/autonomy' && (!init || !init.method || init.method === 'GET')) {
        return jsonResponse({
          rules: [
            {
              id: 'rule-1',
              actionType: 'send_email',
              employeeRole: 'customer',
              autonomyTier: 2,
              reversibility: 'reversible',
              requiresHumanApproval: true,
              confidenceThreshold: 0.85,
              locked: false,
              updatedAt: '2026-09-20T00:00:00.000Z',
            },
          ],
        });
      }
      if (path === '/api/settings/pending') {
        return jsonResponse({
          pending: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              actionType: 'send_email',
              employeeRole: 'customer',
              ageHours: 2.5,
              expiresAt: null,
            },
          ],
        });
      }
      if (path === '/api/settings/suppressions') {
        return jsonResponse({ suppressions: [] });
      }
      if (path === '/api/settings/autonomy' && init?.method === 'PATCH') {
        return jsonResponse({ success: true, actionType: 'send_email', autonomyTier: 3 });
      }
      if (path === '/api/decisions' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        return jsonResponse({ id: body.id, status: body.status });
      }
      return jsonResponse({ error: 'unexpected' }, false, 500);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AutonomySettings />);

    expect(await screen.findByLabelText('Autonomy tier for send_email')).toBeInTheDocument();
    expect(screen.getByText(/2\.5 hours old/)).toBeInTheDocument();

    const tierSelect = screen.getByLabelText('Autonomy tier for send_email');
    fireEvent.change(tierSelect, { target: { value: '3' } });

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === '/api/settings/autonomy' && init?.method === 'PATCH'
      );
      expect(patchCalls.length).toBe(1);
      expect(JSON.parse(String(patchCalls[0][1]?.body))).toEqual({
        actionType: 'send_email',
        employeeRole: 'customer',
        autonomyTier: 3,
        reversibility: 'reversible',
        confidenceThreshold: 0.85,
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      const decisionCalls = fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === '/api/decisions' && init?.method === 'PATCH'
      );
      expect(decisionCalls.length).toBe(1);
      expect(JSON.parse(String(decisionCalls[0][1]?.body))).toEqual({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'approved',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('Nothing waiting.')).toBeInTheDocument();
    });
  });

  it('shows API error when approve fails and keeps the pending row', async () => {
    const fetchMock = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === '/api/settings/autonomy') {
        return jsonResponse({ rules: [] });
      }
      if (path === '/api/settings/pending') {
        return jsonResponse({
          pending: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              actionType: 'refund',
              employeeRole: 'customer',
              ageHours: 1,
              expiresAt: null,
            },
          ],
        });
      }
      if (path === '/api/settings/suppressions') {
        return jsonResponse({ suppressions: [] });
      }
      if (path === '/api/decisions' && init?.method === 'PATCH') {
        return jsonResponse(
          { error: 'Only workspace owners and admins can approve refunds.' },
          false,
          403
        );
      }
      return jsonResponse({ error: 'unexpected' }, false, 500);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AutonomySettings />);

    expect(await screen.findByText('refund')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(
      await screen.findByText('Only workspace owners and admins can approve refunds.')
    ).toBeInTheDocument();
    expect(screen.getByText('refund')).toBeInTheDocument();
  });

  it('saves confidence + reversibility and creates a new rule via PATCH', async () => {
    const fetchMock = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === '/api/settings/autonomy' && init?.method === 'PATCH') return jsonResponse({ success: true });
      if (path === '/api/settings/autonomy') {
        return jsonResponse({
          rules: [
            { id: 'rule-1', actionType: 'send_email', employeeRole: 'customer', autonomyTier: 2, reversibility: 'reversible', requiresHumanApproval: true, confidenceThreshold: 0.85, locked: false, updatedAt: '2026-09-20T00:00:00.000Z' },
          ],
        });
      }
      if (path === '/api/settings/pending') return jsonResponse({ pending: [] });
      if (path === '/api/settings/suppressions') return jsonResponse({ suppressions: [] });
      return jsonResponse({ error: 'unexpected' }, false, 500);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const patches = () =>
      fetchMock.mock.calls
        .filter(([u, i]) => String(u) === '/api/settings/autonomy' && i?.method === 'PATCH')
        .map(([, i]) => JSON.parse(String(i?.body)));

    render(<AutonomySettings />);
    fireEvent.change(await screen.findByLabelText('Confidence threshold for send_email'), { target: { value: '0.6' } });
    fireEvent.change(screen.getByLabelText('Reversibility for send_email'), { target: { value: 'irreversible' } });
    fireEvent.click(screen.getByLabelText('Save details for send_email'));
    await waitFor(() => expect(patches().length).toBe(1));
    expect(patches()[0]).toEqual({
      actionType: 'send_email', employeeRole: 'customer', autonomyTier: 2, reversibility: 'irreversible', confidenceThreshold: 0.6,
    });

    fireEvent.change(screen.getByLabelText('New rule action type'), { target: { value: 'slack.post' } });
    fireEvent.change(screen.getByLabelText('New rule autonomy tier'), { target: { value: '3' } });
    fireEvent.click(screen.getByText('Add rule'));
    await waitFor(() => expect(patches().length).toBe(2));
    expect(patches()[1]).toEqual({ actionType: 'slack.post', employeeRole: null, autonomyTier: 3, reversibility: 'reversible' });
  });

  it('rejects an out-of-range confidence without calling the API', async () => {
    const fetchMock = jest.fn((url: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(url);
      if (path === '/api/settings/autonomy') return jsonResponse({ rules: [] });
      if (path === '/api/settings/pending') return jsonResponse({ pending: [] });
      return jsonResponse({ suppressions: [] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<AutonomySettings />);
    fireEvent.change(await screen.findByLabelText('New rule action type'), { target: { value: 'x.y' } });
    fireEvent.change(screen.getByLabelText('New rule confidence threshold'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByText('Add rule'));
    expect(await screen.findByRole('alert')).toHaveTextContent('between 0 and 1');
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(false);
  });
});

