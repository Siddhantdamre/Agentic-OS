import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AnalyticsPage from '../page';

function mockAnalyticsFetch(analyticsBody: unknown, opts: { analyticsOk?: boolean } = {}) {
  return jest.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/analytics?range=')) {
      return Promise.resolve({
        ok: opts.analyticsOk ?? true,
        status: 200,
        json: async () => analyticsBody,
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
}

describe('AnalyticsPage', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('renders analytics data with metrics and trends', async () => {
    global.fetch = mockAnalyticsFetch({
      metrics: {
        totalConversations: 142,
        resolvedConversations: 120,
        activeConversations: 22,
        totalMessages: 680,
        automationRate: '78.5%',
        avgResponseTime: '2.4s',
        csatScore: '4.7 / 5',
        conversationChangePct: 15,
      },
      channelBreakdown: [
        { channel: 'whatsapp', count: 85 },
        { channel: 'gmail', count: 57 },
      ],
      weeklyTrend: [
        { day: 'Mon', count: 18 },
        { day: 'Tue', count: 24 },
        { day: 'Wed', count: 30 },
      ],
    });

    render(<AnalyticsPage />);

    expect(screen.getByText('Analytics & Performance')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('142')).toBeInTheDocument();
      expect(screen.getByText('78.5%')).toBeInTheDocument();
      expect(screen.getByText('2.4s')).toBeInTheDocument();
      expect(screen.getByText('4.7 / 5')).toBeInTheDocument();
      expect(screen.getByText('+15% vs prior window')).toBeInTheDocument();
      expect(screen.getByText('whatsapp')).toBeInTheDocument();
      expect(screen.getByText('gmail')).toBeInTheDocument();
    });
  });

  it('handles error state and allows retry', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('Network disconnected'))
      .mockImplementation(
        mockAnalyticsFetch({
          metrics: {
            totalConversations: 5,
            resolvedConversations: 4,
            activeConversations: 1,
            totalMessages: 20,
            automationRate: '50.0%',
            avgResponseTime: '3.1s',
            csatScore: '4.0 / 5',
            conversationChangePct: null,
          },
          channelBreakdown: [],
          weeklyTrend: [],
        })
      );

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(screen.getByText('Network disconnected')).toBeInTheDocument();
    });

    const retryBtn = screen.getByText('Retry');
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByText('5')).toBeInTheDocument();
      expect(screen.queryByText('Network disconnected')).not.toBeInTheDocument();
    });
  });

  it('renders empty weekly trend placeholder when no trend data exists', async () => {
    global.fetch = mockAnalyticsFetch({
      metrics: {
        totalConversations: 0,
        resolvedConversations: 0,
        activeConversations: 0,
        totalMessages: 0,
        automationRate: '0%',
        avgResponseTime: 'N/A',
        csatScore: 'N/A',
        conversationChangePct: null,
      },
      channelBreakdown: [],
      weeklyTrend: [],
    });

    render(<AnalyticsPage />);

    await waitFor(() => {
      expect(
        screen.getByText('No conversation volume recorded in this range.')
      ).toBeInTheDocument();
      expect(screen.getByText('No active channels yet.')).toBeInTheDocument();
    });
  });
});
