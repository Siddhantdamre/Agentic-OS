'use client';

import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  TrendingUp,
  MessageSquare,
  Clock,
  CheckCircle2,
  PieChart,
  Layers,
  Zap,
  Star,
} from 'lucide-react';

interface AnalyticsData {
  metrics: {
    totalConversations: number;
    resolvedConversations: number;
    activeConversations: number;
    totalMessages: number;
    automationRate: string;
    avgResponseTime: string;
    csatScore: string;
    csatIsProxy?: boolean;
    conversationChangePct?: number | null;
  };
  channelBreakdown: { channel: string; count: number }[];
  weeklyTrend: { day: string; count: number }[];
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/analytics')
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load analytics (${res.status})`);
        return res.json();
      })
      .then((d) => setData(d))
      .catch((err) => {
        console.error(err);
        setError(err?.message || 'Failed to load analytics');
      })
      .finally(() => setLoading(false));
  }, []);

  const metrics = data?.metrics ?? null;
  const weeklyTrend = data?.weeklyTrend ?? [];
  const channelBreakdown = data?.channelBreakdown ?? [];
  const trendMax = Math.max(...weeklyTrend.map((t) => t.count), 1);
  const channelMax = Math.max(...channelBreakdown.map((c) => c.count), 1);
  const changePct = metrics?.conversationChangePct;

  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-12">
      {/* Top Header */}
      <div>
        <h1 className="text-3xl font-serif font-bold text-heading">Analytics & Performance</h1>
        <p className="text-slate-500 text-sm mt-1">
          Deep-dive into customer interaction volume, automation performance, and channel ROI.
        </p>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Primary 4 Stat Cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Conversations</span>
          <div className="text-3xl font-bold text-heading">{loading || !metrics ? '—' : metrics.totalConversations}</div>
          <span className="text-xs text-slate-500 font-medium">
            {changePct == null
              ? 'Not enough prior-week data for a trend'
              : `${changePct >= 0 ? '+' : ''}${changePct}% vs previous 7 days`}
          </span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          {/*
            Named for the population it measures. The home page shows the share
            of conversations that got an agent reply; this shows the share of
            replies that actually called a tool. Both were titled some form of
            "AI automation rate", so the two screens read as 88% and 0.0% for
            what looked like one number. A reply that answers from memory is
            not a failure — it simply is not tool use, and the distinction is
            the point of having both.
          */}
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Replies That Used A Tool</span>
          <div className="text-3xl font-bold text-emerald-600">{loading || !metrics ? '—' : metrics.automationRate}</div>
          <span className="text-xs text-slate-500 font-medium">Share of agent replies that called a tool, not just answered</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Avg Response Time</span>
          <div className="text-3xl font-bold text-heading">{loading || !metrics ? '—' : metrics.avgResponseTime}</div>
          <span className="text-xs text-slate-500 font-medium">User message to next assistant reply</span>
        </div>

        <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">CSAT (proxy)</span>
          <div className="text-3xl font-bold text-amber-600">{loading || !metrics ? '—' : metrics.csatScore}</div>
          <span className="text-xs text-slate-500 font-medium">Resolved conversations mapped to a 5-point scale — not a survey</span>
        </div>
      </div>

      {/* Main Charts Section */}
      <div className="grid grid-cols-12 gap-8">
        {/* Weekly Conversation Volume Trend (8 Cols) */}
        <div className="col-span-8 bg-white border border-cream-300 rounded-3xl p-6 space-y-6 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-serif font-bold text-heading">Weekly Conversation Volume</h2>
              <p className="text-xs text-slate-500">Inbound customer messages processed by AI agents per day</p>
            </div>
            <div className="px-3 py-1 bg-cream-200 text-slate-700 text-xs font-bold rounded-xl border border-cream-300">
              Last 7 Days
            </div>
          </div>

          {/* Bar Chart Visual */}
          <div className="h-64 flex items-end justify-between gap-4 pt-8 px-4">
            {weeklyTrend.map((t) => {
              const heightPercent = Math.round((t.count / trendMax) * 100);
              return (
                <div key={t.day} className="flex-1 flex flex-col items-center gap-2 group relative">
                  <div className="absolute -top-8 px-2 py-1 bg-slate-900 text-white text-[10px] rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-bold">
                    {t.count} conversations
                  </div>

                  <div className="w-full bg-cream-200 rounded-t-xl h-full flex items-end overflow-hidden">
                    <div
                      className="w-full bg-amber-500 group-hover:bg-amber-600 transition-all duration-500 rounded-t-xl"
                      style={{ height: `${heightPercent}%` }}
                    />
                  </div>
                  <span className="text-xs font-bold text-slate-600">{t.day}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Channel Distribution Breakdown (4 Cols) */}
        <div className="col-span-4 bg-white border border-cream-300 rounded-3xl p-6 space-y-6 shadow-sm">
          <div>
            <h2 className="text-lg font-serif font-bold text-heading">Active Channel Share</h2>
            <p className="text-xs text-slate-500">Connected platform distribution</p>
          </div>

          <div className="space-y-4">
            {channelBreakdown.length === 0 ? (
              <p className="text-sm text-slate-500">No active channels yet.</p>
            ) : (
              channelBreakdown.map((cb) => (
              <div key={cb.channel} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700 capitalize">
                  <span className="flex items-center space-x-2">
                    <Layers className="w-4 h-4 text-amber-600" />
                    <span>{cb.channel}</span>
                  </span>
                  <span>{cb.count}</span>
                </div>
                <div className="w-full bg-cream-200 h-2.5 rounded-full overflow-hidden">
                  <div className="bg-amber-500 h-full rounded-full" style={{ width: `${Math.round((cb.count / channelMax) * 100)}%` }} />
                </div>
              </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
