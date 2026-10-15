'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useLiveRefresh } from '@/lib/use-live-refresh';

const ANALYTICS_EVENTS = [
  'conversation_updated',
  'inquiry_updated',
  'inquiry_deleted',
  'work_item_updated',
  'plan_updated',
  'rent_charge_paid',
] as const;
import {
  MessageSquare,
  Clock,
  Layers,
  Zap,
  Star,
  RefreshCw,
  BarChart3,
  Download,
} from 'lucide-react';
import { LiveRegion } from '@/components/a11y';
import { networkErrorMessage } from '@/lib/client-error';

type RangeKey = '24h' | '7d' | '30d' | '90d';

interface AnalyticsData {
  range?: string;
  metrics: {
    totalConversations: number;
    resolvedConversations: number;
    activeConversations: number;
    totalMessages: number;
    automationRate: string;
    conversationAutomationRate?: string;
    toolExecutionRate?: string;
    avgResponseTime: string;
    csatScore: string;
    csatIsProxy?: boolean;
    conversationChangePct?: number | null;
  };
  channelBreakdown: { channel: string; count: number }[];
  weeklyTrend: { day: string; count: number }[];
  gaps?: Array<{ metricId?: string; reason?: string }>;
}

interface RoiData {
  hoursSaved?: number | null;
  hoursByRole?: Array<{ employeeRole: string; hoursSaved: number }>;
  pipeline?: Array<{
    opportunityId?: string;
    stage?: string;
    estimatedValueCents?: number;
    currency?: string;
  }>;
  hasData?: boolean;
  tablesReady?: boolean;
}

interface CostHealthData {
  modelCalls?: number | null;
  spendCents?: number | null;
  sweepShare?: number | null;
  healthy?: boolean | null;
  tablesReady?: boolean;
  hasData?: boolean;
}

interface CalibrationDrift {
  value: number | null;
  status: 'healthy' | 'alert' | 'unknown';
  label: string;
  alertReason: string | null;
}

export default function AnalyticsPage() {
  const [range, setRange] = useState<RangeKey>('7d');
  const [tab, setTab] = useState<'overview' | 'roi' | 'cost' | 'calibration'>('overview');
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [roi, setRoi] = useState<RoiData | null>(null);
  const [costHealth, setCostHealth] = useState<CostHealthData | null>(null);
  const [calibration, setCalibration] = useState<CalibrationDrift | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState('');

  const loadAnalytics = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const [analyticsRes, roiRes, costRes, obsRes] = await Promise.all([
        fetch(`/api/analytics?range=${range}`),
        fetch('/api/analytics/roi'),
        fetch('/api/analytics/cost-health'),
        // One calibration source: observability drift (not a second analytics formula).
        fetch('/api/observability/metrics'),
      ]);
      if (analyticsRes.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!analyticsRes.ok) throw new Error('We couldn’t load analytics. Please try again.');
      const d: AnalyticsData = await analyticsRes.json();
      setData(d);
      setRoi(roiRes.ok ? await roiRes.json() : null);
      setCostHealth(costRes.ok ? await costRes.json() : null);
      if (obsRes.ok) {
        const obsJson = await obsRes.json();
        const drift = (obsJson.metrics || []).find(
          (m: { key?: string }) => m.key === 'confidence_calibration_drift'
        );
        setCalibration(
          drift
            ? {
                value: drift.value ?? null,
                status: drift.status ?? 'unknown',
                label: drift.label || 'Confidence calibration drift',
                alertReason: drift.alertReason ?? null,
              }
            : { value: null, status: 'unknown', label: 'Confidence calibration drift', alertReason: null }
        );
      } else {
        setCalibration(null);
      }
      if (quiet) setError(null);
      setLiveMessage(`Analytics refreshed. ${d.metrics?.totalConversations ?? 0} conversations tracked.`);
    } catch (err: unknown) {
      const msg = networkErrorMessage(err, 'Failed to load analytics');
      // A failed background refresh keeps the last good numbers on screen.
      if (quiet) {
        console.error('[analytics] live refresh failed', err);
      } else {
        setError(msg);
        setLiveMessage(`Failed to load analytics: ${msg}`);
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics]);

  useLiveRefresh({ events: ANALYTICS_EVENTS, refetch: () => loadAnalytics(true) });

  const metrics = data?.metrics ?? null;
  const weeklyTrend = data?.weeklyTrend ?? [];
  const channelBreakdown = data?.channelBreakdown ?? [];
  const gaps = data?.gaps ?? [];
  const trendMax = Math.max(...weeklyTrend.map((t) => t.count), 1);
  const channelMax = Math.max(...channelBreakdown.map((c) => c.count), 1);
  const changePct = metrics?.conversationChangePct;
  const roiHasData = Boolean(roi?.hasData);
  const costHasData = costHealth?.hasData === true;

  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-12">
      <LiveRegion message={liveMessage} />

      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">Analytics & Performance</h1>
          <p className="text-slate-500 text-sm mt-1">
            Real org rollups — conversation automation matches Home; tool rate is separate.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex bg-cream-100 p-1 rounded-xl border border-cream-300 text-xs">
            {(['24h', '7d', '30d', '90d'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 rounded-lg font-medium transition ${
                  range === r ? 'bg-white text-heading shadow-sm' : 'text-slate-500 hover:text-heading'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <a
            href="/api/analytics/export"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-cream-300 rounded-xl text-xs font-medium text-heading hover:bg-cream-50"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </a>
          <button
            type="button"
            onClick={() => void loadAnalytics()}
            className="px-4 py-2 bg-cream-200 hover:bg-cream-300 border border-cream-300 text-slate-700 font-semibold rounded-2xl flex items-center space-x-2 text-xs transition-all"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ['overview', 'Overview'],
            ['roi', 'ROI'],
            ['cost', 'Cost health'],
            ['calibration', 'Calibration'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold border ${
              tab === id
                ? 'bg-amber-500/15 border-amber-500/40 text-heading'
                : 'bg-white border-cream-300 text-slate-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 flex items-center justify-between">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void loadAnalytics()}
            className="text-xs font-bold text-red-700 underline ml-3 hover:text-red-900"
          >
            Retry
          </button>
        </div>
      ) : null}

      {tab === 'overview' ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Total Conversations
                </span>
                <MessageSquare className="w-4 h-4 text-slate-400" />
              </div>
              <div className="text-3xl font-bold text-heading">
                {loading || !metrics ? '—' : metrics.totalConversations}
              </div>
              <span className="text-xs text-slate-500 font-medium">
                {changePct == null
                  ? `No prior ${range} baseline`
                  : `${changePct >= 0 ? '+' : ''}${changePct}% vs prior window`}
              </span>
            </div>
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Conversation Automation
                </span>
                <Zap className="w-4 h-4 text-emerald-700" />
              </div>
              <div className="text-3xl font-bold text-emerald-700">
                {loading || !metrics ? '—' : metrics.automationRate}
              </div>
              <span className="text-xs text-slate-500 font-medium">
                ≥1 AI reply
                {metrics?.toolExecutionRate ? ` · Tool rate ${metrics.toolExecutionRate}` : ''}
              </span>
            </div>
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Avg Response Time
                </span>
                <Clock className="w-4 h-4 text-slate-400" />
              </div>
              <div className="text-3xl font-bold text-heading">
                {loading || !metrics ? '—' : metrics.avgResponseTime}
              </div>
              <span className="text-xs text-slate-500 font-medium">Bounded {range} sample</span>
            </div>
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  CSAT (proxy)
                </span>
                <Star className="w-4 h-4 text-amber-500" />
              </div>
              <div className="text-3xl font-bold text-amber-700">
                {loading || !metrics ? '—' : metrics.csatScore}
              </div>
              <span className="text-xs text-slate-500 font-medium">Resolved ratio — not a survey</span>
            </div>
          </div>

          {gaps.length > 0 ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900 space-y-1">
              <div className="font-semibold">Metric gaps</div>
              {gaps.map((g, i) => (
                <div key={`${g.metricId || 'gap'}-${i}`}>
                  {g.metricId || 'metric'}: {g.reason || 'unavailable'}
                </div>
              ))}
            </div>
          ) : null}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            <div className="lg:col-span-8 bg-white border border-cream-300 rounded-3xl p-6 space-y-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-serif font-bold text-heading">Conversation volume</h2>
                  <p className="text-xs text-slate-500">Inbound customer messages processed by AI agents in {range}</p>
                </div>
                <div className="px-3 py-1 bg-cream-200 text-slate-700 text-xs font-bold rounded-xl border border-cream-300">
                  {range}
                </div>
              </div>
              {weeklyTrend.length === 0 ? (
                <div className="h-64 flex flex-col items-center justify-center text-slate-400 space-y-2">
                  <BarChart3 className="w-8 h-8 opacity-40" />
                  <p className="text-xs">No conversation volume recorded in this range.</p>
                </div>
              ) : (
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
              )}
            </div>
            <div className="lg:col-span-4 bg-white border border-cream-300 rounded-3xl p-6 space-y-6 shadow-sm">
              <div>
                <h2 className="text-lg font-serif font-bold text-heading">Active channel share</h2>
                <p className="text-xs text-slate-500">Connected platforms</p>
              </div>
              <div className="space-y-4">
                {channelBreakdown.length === 0 ? (
                  <p className="text-sm text-slate-500">No active channels yet.</p>
                ) : (
                  channelBreakdown.map((cb) => (
                    <div key={cb.channel} className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs font-semibold text-slate-700 capitalize">
                        <span className="flex items-center space-x-2">
                          <Layers className="w-4 h-4 text-amber-700" />
                          <span>{cb.channel}</span>
                        </span>
                        <span>{cb.count}</span>
                      </div>
                      <div className="w-full bg-cream-200 h-2.5 rounded-full overflow-hidden">
                        <div
                          className="bg-amber-500 h-full rounded-full transition-all duration-300"
                          style={{ width: `${Math.round((cb.count / channelMax) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      ) : null}

      {tab === 'roi' ? (
        <div className="bg-white border border-cream-300 rounded-3xl overflow-hidden shadow-sm">
          <div className="p-4 border-b border-cream-200">
            <h2 className="text-base font-serif font-bold text-heading">AI employee labor ROI</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Hours saved from `employee_roi_metrics` · pipeline from `growth_pipeline_attribution`
            </p>
            {roi?.tablesReady === false ? (
              <p className="text-sm text-slate-500 mt-2">No data — ROI tables not migrated yet.</p>
            ) : !roiHasData ? (
              <p className="text-sm text-slate-500 mt-2">No data</p>
            ) : (
              <p className="text-sm text-heading mt-2 font-semibold">
                Total hours saved: {roi?.hoursSaved ?? 0}
              </p>
            )}
          </div>
          {roiHasData ? (
            <>
              <table className="w-full text-left text-xs">
                <thead className="bg-cream-100 text-slate-500 uppercase">
                  <tr>
                    <th className="p-3">Role</th>
                    <th className="p-3">Hours saved</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-cream-200">
                  {(roi?.hoursByRole || []).length === 0 ? (
                    <tr>
                      <td colSpan={2} className="p-6 text-center text-slate-500">
                        No hours-saved rows (pipeline only).
                      </td>
                    </tr>
                  ) : (
                    (roi?.hoursByRole || []).map((r) => (
                      <tr key={r.employeeRole}>
                        <td className="p-3 font-medium text-heading">{r.employeeRole}</td>
                        <td className="p-3">{r.hoursSaved}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              {(roi?.pipeline || []).length > 0 ? (
                <div className="p-4 border-t border-cream-200 space-y-2">
                  <div className="text-xs font-semibold text-slate-500 uppercase">Pipeline attribution</div>
                  {(roi?.pipeline || []).slice(0, 10).map((p, i) => (
                    <div key={p.opportunityId || i} className="text-xs text-slate-700 flex justify-between gap-2">
                      <span>
                        {p.stage || 'stage'} · {p.opportunityId || '—'}
                      </span>
                      <span className="font-mono">
                        {((p.estimatedValueCents || 0) / 100).toFixed(0)} {p.currency || 'USD'}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {tab === 'cost' ? (
        <div className="bg-white border border-cream-300 rounded-3xl p-6 space-y-3 shadow-sm">
          <h2 className="text-base font-serif font-bold text-heading">Cost health (7d)</h2>
          {costHealth?.tablesReady === false ? (
            <p className="text-sm text-slate-500">No data — spend tables not migrated yet.</p>
          ) : !costHasData ? (
            <p className="text-sm text-slate-500">No data</p>
          ) : (
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <dt className="text-xs text-slate-500">Model calls</dt>
                <dd className="text-xl font-bold text-heading">{costHealth?.modelCalls}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Spend</dt>
                <dd className="text-xl font-bold text-heading">
                  ${(((costHealth?.spendCents ?? 0) as number) / 100).toFixed(2)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Sweep share</dt>
                <dd className="text-xl font-bold text-heading">
                  {costHealth?.sweepShare == null
                    ? 'No data'
                    : `${(costHealth.sweepShare * 100).toFixed(1)}%`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Healthy</dt>
                <dd className="text-xl font-bold text-heading">
                  {costHealth?.healthy == null ? 'No data' : costHealth.healthy ? 'yes' : 'no'}
                </dd>
              </div>
            </dl>
          )}
        </div>
      ) : null}

      {tab === 'calibration' ? (
        <div className="bg-white border border-cream-300 rounded-3xl p-6 space-y-3 shadow-sm">
          <h2 className="text-base font-serif font-bold text-heading">
            {calibration?.label || 'Confidence calibration drift'}
          </h2>
          <p className="text-xs text-slate-500">
            Same source as Observability (`/api/observability/metrics`) — mean |confidence − outcome|
            over executed decisions with feedback.
          </p>
          {loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : !calibration || calibration.value == null || calibration.status === 'unknown' ? (
            <p className="text-sm text-slate-500">No data</p>
          ) : (
            <div className="space-y-1">
              <p className="text-3xl font-bold text-heading">{calibration.value.toFixed(3)}</p>
              <p className="text-xs text-slate-500 capitalize">Status: {calibration.status}</p>
              {calibration.alertReason ? (
                <p className="text-xs text-red-700">{calibration.alertReason}</p>
              ) : null}
              <a href="/observability" className="inline-block text-xs text-amber-700 underline mt-2">
                Open Observability for the full metric band
              </a>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
