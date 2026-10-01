import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentTrajectory, buildTrajectory } from '../AgentTrajectory';
import { startRealNangoOAuth } from '@/lib/nango-client';

jest.mock('@/lib/nango-client', () => ({
  startRealNangoOAuth: jest.fn(async () => ({ success: true, provider: 'gmail' })),
}));

describe('buildTrajectory subagent pairing', () => {
  const subagents = [
    {
      threadId: 'thread-1',
      title: 'Research vendors',
      name: 'researcher',
      instruction: 'Compare three vendors on price.',
      status: 'started' as const,
      createdAt: new Date().toISOString(),
    },
    {
      threadId: 'thread-1',
      title: 'Research vendors',
      name: 'researcher',
      instruction: 'Compare three vendors on price.',
      status: 'done' as const,
      durationMs: 12345,
      createdAt: new Date().toISOString(),
    },
  ];

  it('attaches name, instruction and duration to subagent spans', () => {
    const data = buildTrajectory({
      executedSteps: [
        { step: 1, action: 'subagent_start', toolUsed: 'subagent_start', result: 'researcher' },
        { step: 2, action: 'web_search', toolUsed: 'web_search', result: '{"status":"executed"}' },
        { step: 3, action: 'subagent_done', toolUsed: 'subagent_done', result: 'thread-1' },
      ],
      done: true,
      subagents,
    });
    expect(data.steps).toHaveLength(1);
    const sub = data.steps[0];
    expect(sub.children).toHaveLength(1);
    expect(sub.subagentName).toBe('researcher');
    expect(sub.subagentInstruction).toBe('Compare three vendors on price.');
    expect(sub.durationMs).toBe(12345);
    expect(sub.status).toBe('success');
  });

  it('keeps parallel subagents as siblings and files each tool under its thread', () => {
    const data = buildTrajectory({
      executedSteps: [
        { step: 1, action: 'subagent_start', toolUsed: 'subagent_start', result: 'researcher', threadId: 'thread-a' },
        { step: 2, action: 'subagent_start', toolUsed: 'subagent_start', result: 'writer', threadId: 'thread-b' },
        { step: 3, action: 'web_search', toolUsed: 'web_search', result: '{"status":"executed"}', threadId: 'thread-a' },
        { step: 4, action: 'docs_create', toolUsed: 'docs_create', result: '{"status":"executed"}', threadId: 'thread-b' },
        { step: 5, action: 'subagent_done', toolUsed: 'subagent_done', result: 'thread-b', threadId: 'thread-b' },
        { step: 6, action: 'subagent_done', toolUsed: 'subagent_done', result: 'thread-a', threadId: 'thread-a' },
      ],
      done: true,
      subagents: [
        { threadId: 'thread-a', title: 'Research', name: 'researcher', instruction: 'Search', status: 'started', createdAt: new Date().toISOString() },
        { threadId: 'thread-b', title: 'Write', name: 'writer', instruction: 'Draft', status: 'started', createdAt: new Date().toISOString() },
        { threadId: 'thread-a', title: 'Research', name: 'researcher', instruction: 'Search', status: 'done', durationMs: 10, createdAt: new Date().toISOString() },
        { threadId: 'thread-b', title: 'Write', name: 'writer', instruction: 'Draft', status: 'done', durationMs: 20, createdAt: new Date().toISOString() },
      ],
    });
    expect(data.steps).toHaveLength(2);
    expect(data.steps[0].subagentName).toBe('researcher');
    expect(data.steps[0].children?.map((c) => c.tool)).toEqual(['web_search']);
    expect(data.steps[1].subagentName).toBe('writer');
    expect(data.steps[1].children?.map((c) => c.tool)).toEqual(['docs_create']);
    expect(data.steps[0].status).toBe('success');
    expect(data.steps[1].status).toBe('success');
  });

  it('leaves spans unnamed when no lifecycle events arrived', () => {
    const data = buildTrajectory({
      executedSteps: [
        { step: 1, action: 'subagent_start', toolUsed: 'subagent_start', result: '' },
        { step: 2, action: 'subagent_done', toolUsed: 'subagent_done', result: '' },
      ],
      done: true,
    });
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0].subagentName).toBeUndefined();
  });

  it('passes through turn usage for the footer', () => {
    const data = buildTrajectory({
      executedSteps: [{ step: 1, action: 'x', toolUsed: 'database_query', result: '{}' }],
      done: true,
      usage: { totalTokens: 1500, durationMs: 20000, totalCostInUsd: 0.002 },
    });
    expect(data.usage?.totalTokens).toBe(1500);
  });
});

describe('AgentTrajectory rendering', () => {
  it('shows search sources instead of a raw object dump', () => {
    const data = buildTrajectory({
      executedSteps: [
        {
          step: 1,
          action: 'web_search',
          toolUsed: 'web_search',
          result: JSON.stringify({
            error: [{
              type: 'text',
              text: `\n<untrusted_tool_data>\n${JSON.stringify({
                status: 'executed',
                message: 'Found 1 live web search result',
                data: {
                  query: 'founders of darexai',
                  results: [
                    {
                      title: 'Sanu Shaurya — Founder',
                      url: 'https://www.linkedin.com/in/sanu',
                      snippet: 'Founder at DarexAI.',
                    },
                  ],
                },
              })}\n</untrusted_tool_data>\n`,
            }],
          }),
        },
      ],
      done: true,
    });
    render(<AgentTrajectory data={data} onAllow={() => undefined} onDeny={() => undefined} />);
    expect(screen.getByText('Sanu Shaurya — Founder')).toBeInTheDocument();
    expect(screen.getByText('linkedin.com')).toBeInTheDocument();
    expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
    expect(screen.queryByText('web_search')).not.toBeInTheDocument();
  });

  it('renders subagent card with instruction toggle and duration', () => {
    const data = buildTrajectory({
      executedSteps: [
        { step: 1, action: 'subagent_start', toolUsed: 'subagent_start', result: '' },
        { step: 2, action: 'web_search', toolUsed: 'web_search', result: '{"status":"executed"}' },
        { step: 3, action: 'subagent_done', toolUsed: 'subagent_done', result: '' },
      ],
      done: true,
      subagents: [
        {
          threadId: 't1',
          title: 'Research',
          name: 'researcher',
          instruction: 'Compare vendors.',
          status: 'started' as const,
          createdAt: new Date().toISOString(),
        },
        {
          threadId: 't1',
          title: 'Research',
          name: 'researcher',
          instruction: 'Compare vendors.',
          status: 'done' as const,
          durationMs: 6500,
          createdAt: new Date().toISOString(),
        },
      ],
      usage: { totalTokens: 1500, durationMs: 20000 },
    });
    render(<AgentTrajectory data={data} onAllow={() => undefined} onDeny={() => undefined} />);
    expect(screen.getByText(/^researcher$/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Task instruction'));
    expect(screen.getByText('Compare vendors.')).toBeInTheDocument();
    expect(screen.getByText(/6\.5s/)).toBeInTheDocument();
    expect(screen.getByText(/1\.5k tokens/)).toBeInTheDocument();
  });

  it('does not leave a finished ask-user step spinning', () => {
    const data = buildTrajectory({
      executedSteps: [
        {
          step: 1,
          action: 'approval_required',
          toolUsed: 'approval_required',
          result: 'ask_user_question needs approval',
        },
      ],
      done: true,
    });
    expect(data.steps).toHaveLength(0);
    expect(data.running).toBe(false);
  });

  it('renders deny-reason flow on approval bars', () => {
    const data = buildTrajectory({
      executedSteps: [],
      toolEvents: [{ tool: 'approval_required', label: 'gmail_send needs approval' }],
      done: false,
      sessionId: 's1',
      approvals: [{ threadId: 'th', toolCallId: 'tc', toolName: 'gmail_send' }],
    });
    const onDeny = jest.fn();
    render(<AgentTrajectory data={data} onAllow={() => undefined} onDeny={onDeny} />);
    fireEvent.click(screen.getByText('Deny'));
    fireEvent.click(screen.getByText('Submit'));
    expect(screen.getByText('Reason is required')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Enter reason for denial (required)'), {
      target: { value: 'not today' },
    });
    fireEvent.click(screen.getByText('Submit'));
    expect(onDeny).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'tc' }),
      'not today'
    );
  });

  it('starts sign-in for the account a tool step needs', async () => {
    const start = startRealNangoOAuth as jest.Mock;
    start.mockClear();
    start.mockResolvedValue({ success: true, provider: 'gmail' });
    const data = buildTrajectory({
      executedSteps: [{
        step: 1,
        action: 'send',
        toolUsed: 'gmail_send',
        result: JSON.stringify({
          status: 'error',
          message: 'gmail is not signed in',
          data: { connected: false, setupUrl: '/connectors?connect=gmail' },
        }),
      }],
      done: true,
    });
    render(<AgentTrajectory data={data} onAllow={() => undefined} onDeny={() => undefined} />);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in to use this tool' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('gmail'));
    await waitFor(() => expect(screen.getByText('Signed in. Send the question again to use this account.')).toBeInTheDocument());
  });
});
