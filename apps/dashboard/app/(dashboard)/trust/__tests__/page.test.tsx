import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import TrustPage from '../page';

jest.mock('next/link', () => {
  const MockLink = ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>;
  MockLink.displayName = 'MockLink';
  return MockLink;
});

type Json = Record<string, unknown>;

const evidence = (o: Json = {}) => ({
  approvedAsIs: 0, approvedEdited: 0, rejected: 0, expired: 0, waiting: 0, failedToRun: 0, carriedOut: 0, withProblems: 0,
  outcomesTracked: false, lastDecisionAt: null, decided: 0, approvalRate: null, asIsRate: null, enough: false, stillNeeded: 10,
  problemRate: null, concerns: [], ...o,
});

const rows = (stage: number) => {
  const outcomes: Record<number, string[]> = {
    0: ['runs', 'recorded', 'recorded', 'asks', 'recorded'],
    1: ['runs', 'runs', 'asks', 'asks', 'asks'],
    2: ['runs', 'runs', 'asks', 'asks', 'asks'],
    3: ['runs', 'runs', 'asks', 'asks', 'asks'],
  };
  const groups = ['look_up', 'draft', 'send_publish', 'pay_delete', 'sign_execute'];
  return groups.map((group, i) => ({ group, outcome: outcomes[stage][i] }));
};

const payload = (over: Json = {}): Json => ({
  orgId: 'o', canManage: true, canReview: true, stage: 0, killSwitch: false,
  since: '2026-09-01T00:00:00.000Z', sinceApproximate: false,
  levels: [0, 1, 2, 3].map((s) => ({ stage: s, rows: rows(s), sameAsPrevious: s >= 2 })),
  recommendation: {
    kind: 'hold', reasons: ['shadow_reviewed', 'shadow_agreement'],
    requirements: [
      { id: 'shadow_reviewed', have: 32, need: 50, direction: 'at_least', met: false },
      { id: 'shadow_agreement', have: 0.84, need: 0.9, direction: 'at_least', met: false },
    ],
  },
  workspace: { stage: 0, killSwitch: false, weeksInStage: 5, stateDivergences: 0, shadowReviewed: 32, shadowAgreed: 27, decisionsInStage: 0, approvalRate: null, recentDecided: 0, recentApprovalRate: null },
  employees: [
    { id: 'e1', name: 'Maya', role: 'customer', status: 'active', evidence: evidence({ approvedAsIs: 18, approvedEdited: 4, rejected: 3, decided: 25, approvalRate: 0.88, asIsRate: 0.72, enough: true, stillNeeded: 0 }) },
    { id: 'e2', name: 'Ravi', role: 'growth', status: 'active', evidence: evidence({ approvedAsIs: 2, decided: 2, approvalRate: 1, asIsRate: 1, stillNeeded: 8 }) },
  ],
  unattributed: evidence(),
  shadow: { reviewed: 32, agreed: 27, waiting: 2 },
  outcomesTracked: false,
  history: [],
  asOf: '2026-10-06T00:00:00.000Z',
  ...over,
});

const shadowItems = {
  items: [
    { id: 'd1', employee: 'Maya', what: 'Send email "Your viewing" to priya@example.com', at: '2026-10-05T10:00:00.000Z' },
    { id: 'd2', employee: 'Maya', what: 'Gmail: send email', at: '2026-10-05T09:00:00.000Z' },
  ],
  waiting: 2, reviewed: 32, agreed: 27,
};

let calls: Array<{ url: string; method: string; body: Json | null }>;
let routes: Record<string, (body: Json | null) => { status?: number; json: unknown } | Promise<never>>;

function mockFetch() {
  calls = [];
  global.fetch = jest.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : null;
    calls.push({ url: u, method, body });
    const handler = routes[`${method} ${u}`];
    if (!handler) return Promise.reject(new Error(`Unhandled fetch ${method} ${u}`));
    const result = handler(body);
    // A handler that returns a rejected promise stands for a dropped connection.
    if (result instanceof Promise) return result as unknown as Promise<Response>;
    const out = result as { status?: number; json: unknown };
    const status = out.status ?? 200;
    return Promise.resolve({ ok: status < 400, status, json: async () => out.json } as Response);
  }) as jest.Mock;
}

beforeEach(() => {
  jest.resetAllMocks();
  routes = {
    'GET /api/trust': () => ({ json: payload() }),
    'GET /api/trust/shadow': () => ({ json: shadowItems }),
  };
  mockFetch();
});

describe('Trust page', () => {
  it('says which level the team is at and what that level lets it do, in plain words', async () => {
    render(<TrustPage />);
    expect(await screen.findByRole('heading', { name: /level 0/i })).toBeInTheDocument();
    expect(screen.getByText(/watching/i, { selector: 'h2 *, h2' })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: /what your team can do at this level/i });
    expect(within(list).getByText(/look things up/i).closest('li')).toHaveTextContent(/does it on its own/i);
    expect(within(list).getByText(/write drafts/i).closest('li')).toHaveTextContent(/only writes down what it would do/i);
    expect(within(list).getByText(/send messages/i).closest('li')).toHaveTextContent(/only writes down/i);
    expect(within(list).getByText(/payments|refund/i).closest('li')).toHaveTextContent(/asks you first/i);
  });

  it('promises nothing that the table does not: sending and money never run without a person', async () => {
    render(<TrustPage />);
    expect(await screen.findByText(/without a person|waits for a person|always wait/i)).toBeInTheDocument();
  });

  it('shows what is still needed to move up, with the numbers measured so far', async () => {
    render(<TrustPage />);
    expect(await screen.findByText(/reviewed 32 of 50/i)).toBeInTheDocument();
    expect(screen.getByText(/agreed with at least 90%/i)).toBeInTheDocument();
    expect(screen.getByText(/84% so far/i)).toBeInTheDocument();
    expect(screen.getByText(/not yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^move to level 1$/i })).not.toBeInTheDocument();
  });

  it('lets a manager move up early, but only with the early move spelled out and recorded', async () => {
    routes['PATCH /api/org/rollout'] = () => ({ json: { stage: 1 } });
    render(<TrustPage />);
    fireEvent.click(await screen.findByRole('button', { name: /move up anyway/i }));
    expect(screen.getByText(/recorded as moved up early/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/why/i), { target: { value: 'Pilot customer asked' } });
    fireEvent.click(screen.getByRole('button', { name: /confirm: move to level 1/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ stage: 1, force: true, reason: 'Pilot customer asked' });
  });

  it('offers the plain move up once every requirement is met', async () => {
    routes['GET /api/trust'] = () => ({
      json: payload({
        recommendation: { kind: 'advance', reasons: [], requirements: [
          { id: 'shadow_reviewed', have: 50, need: 50, direction: 'at_least', met: true },
          { id: 'shadow_agreement', have: 0.94, need: 0.9, direction: 'at_least', met: true },
        ] },
      }),
    });
    routes['PATCH /api/org/rollout'] = () => ({ json: { stage: 1 } });
    render(<TrustPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^move to level 1$/i }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ stage: 1 }));
  });

  it('suggests going back, with the reason in numbers, when recent decisions are mostly turned down', async () => {
    routes['GET /api/trust'] = () => ({
      json: payload({
        stage: 2,
        recommendation: { kind: 'pull_back', reasons: ['recent_approval_low'], requirements: [] },
        workspace: { stage: 2, killSwitch: false, weeksInStage: 6, stateDivergences: 0, shadowReviewed: 50, shadowAgreed: 48, decisionsInStage: 80, approvalRate: 0.7, recentDecided: 30, recentApprovalRate: 0.4 },
      }),
    });
    routes['PATCH /api/org/rollout'] = () => ({ json: { stage: 1 } });
    render(<TrustPage />);
    expect(await screen.findByText(/suggest moving back to level 1/i)).toBeInTheDocument();
    expect(screen.getByText(/40%/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /move back to level 1/i }));
    fireEvent.click(await screen.findByRole('button', { name: /yes, move back/i }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ stage: 1 }));
  });

  it('says so, instead of implying more, when a level allows what the one below allows', async () => {
    routes['GET /api/trust'] = () => ({
      json: payload({ stage: 2, recommendation: { kind: 'hold', reasons: ['gated_decisions'], requirements: [{ id: 'gated_decisions', have: 12, need: 100, direction: 'at_least', met: false }] } }),
    });
    render(<TrustPage />);
    expect(await screen.findByText(/allows the same as level 1/i)).toBeInTheDocument();
  });

  it('lets someone who may not change settings look, and says why the buttons are missing', async () => {
    routes['GET /api/trust'] = () => ({ json: payload({ canManage: false }) });
    render(<TrustPage />);
    expect(await screen.findByText(/owner or admin can change/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /move up anyway/i })).not.toBeInTheDocument();
  });

  it('shows the paused state and does not offer to move up', async () => {
    routes['GET /api/trust'] = () => ({
      json: payload({ killSwitch: true, recommendation: { kind: 'hold', reasons: ['paused'], requirements: [] } }),
    });
    render(<TrustPage />);
    expect(await screen.findByText(/your team is paused/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /move up anyway/i })).not.toBeInTheDocument();
  });

  it('lets a manager pause the team in one click, and resume it later', async () => {
    routes['PATCH /api/org/kill-switch'] = () => ({ json: { enabled: true } });
    render(<TrustPage />);
    fireEvent.click(await screen.findByRole('button', { name: /pause my team/i }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/org/kill-switch')?.body).toEqual({ enabled: true }));
  });

  it('offers to resume a paused team, and nothing else about moving up', async () => {
    routes['GET /api/trust'] = () => ({ json: payload({ killSwitch: true, recommendation: { kind: 'hold', reasons: ['paused'], requirements: [] } }) });
    routes['PATCH /api/org/kill-switch'] = () => ({ json: { enabled: false } });
    render(<TrustPage />);
    fireEvent.click(await screen.findByRole('button', { name: /resume my team/i }));
    await waitFor(() => expect(calls.find((c) => c.url === '/api/org/kill-switch')?.body).toEqual({ enabled: false }));
    expect(screen.queryByRole('button', { name: /pause my team/i })).not.toBeInTheDocument();
  });

  it('does not show pause or resume to someone who may not change settings', async () => {
    routes['GET /api/trust'] = () => ({ json: payload({ canManage: false }) });
    render(<TrustPage />);
    await screen.findByText(/owner or admin can change/i);
    expect(screen.queryByRole('button', { name: /pause my team|resume my team/i })).not.toBeInTheDocument();
  });

  it('refuses to call a small sample a track record', async () => {
    render(<TrustPage />);
    const ravi = (await screen.findByText('Ravi')).closest('li')!;
    expect(ravi).toHaveTextContent(/8 more decisions/i);
    expect(ravi).not.toHaveTextContent(/100%/);
    const maya = screen.getByText('Maya', { selector: 'li *' }).closest('li')!;
    expect(maya).toHaveTextContent(/88%/);
  });

  it('says what it cannot measure yet rather than leaving it out', async () => {
    render(<TrustPage />);
    expect(await screen.findByText(/don.t yet record when an action is undone/i)).toBeInTheDocument();
  });

  it('shows what the team would have done and records yes or no, updating the count', async () => {
    routes['POST /api/trust/shadow'] = () => ({ json: { ok: true, waiting: 1, reviewed: 33, agreed: 28 } });
    render(<TrustPage />);
    const first = (await screen.findByText(/your viewing/i)).closest('li')!;
    fireEvent.click(within(first).getByRole('button', { name: /yes, same/i }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ id: 'd1', agreed: true }));
    await waitFor(() => expect(screen.queryByText(/your viewing/i)).not.toBeInTheDocument());
    expect(screen.getByText(/33 reviewed/i)).toBeInTheDocument();
  });

  it('records a no', async () => {
    routes['POST /api/trust/shadow'] = () => ({ json: { ok: true, waiting: 1, reviewed: 33, agreed: 27 } });
    render(<TrustPage />);
    const second = (await screen.findByText(/gmail: send email/i)).closest('li')!;
    fireEvent.click(within(second).getByRole('button', { name: /no, i wouldn.t/i }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ id: 'd2', agreed: false }));
  });

  it('lists the changes that were made, who made them, and why', async () => {
    routes['GET /api/trust'] = () => ({
      json: payload({
        stage: 1,
        history: [
          { id: 'h1', fromStage: 0, toStage: 1, kind: 'override', reason: 'Pilot customer asked', by: 'owner@example.com', at: '2026-09-20T09:00:00.000Z', evidence: {} },
          { id: 'h2', fromStage: 2, toStage: 0, kind: 'pause', reason: 'The team was paused, which returns it to level 0.', by: null, at: '2026-09-10T09:00:00.000Z', evidence: {} },
        ],
      }),
    });
    render(<TrustPage />);
    const history = await screen.findByRole('list', { name: /changes to your team.s level/i });
    expect(within(history).getByText(/moved up early/i)).toBeInTheDocument();
    expect(within(history).getByText(/owner@example.com/)).toBeInTheDocument();
    expect(within(history).getByText(/pilot customer asked/i)).toBeInTheDocument();
    expect(within(history).getByText('Paused')).toBeInTheDocument();
  });

  it('shows a plain sentence and a retry when the connection drops, never the browser’s own words', async () => {
    routes['GET /api/trust'] = () => Promise.reject(new TypeError('Failed to fetch'));
    render(<TrustPage />);
    expect(await screen.findByText(/couldn.t reach the server/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed to fetch/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows the server’s plain refusal when a move up is not allowed, and keeps the page usable', async () => {
    routes['PATCH /api/org/rollout'] = () => ({ status: 409, json: { error: 'Need 50 shadow decisions reviewed by an operator' } });
    render(<TrustPage />);
    fireEvent.click(await screen.findByRole('button', { name: /move up anyway/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm: move to level 1/i }));
    expect(await screen.findByText(/need 50 .*reviewed/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /level 0/i })).toBeInTheDocument();
  });
});
