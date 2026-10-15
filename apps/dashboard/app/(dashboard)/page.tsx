'use client';

import React, { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ApprovalsCallout } from '@/components/home/ApprovalsCallout';
import { GetStarted } from '@/components/home/GetStarted';
import { DailyDigest } from '@/components/home/DailyDigest';
import { Sparkles, AlertTriangle, Send, CheckCircle2, CircleDashed } from 'lucide-react';
import { LiveRegion, StatusBadge } from '@/components/a11y';
import { useLiveRefresh } from '@/lib/use-live-refresh';

const HOME_EVENTS = [
  'needs_attention',
  'conversation_updated',
  'plan_updated',
  'work_item_updated',
] as const;

export const dynamic = 'force-dynamic';

interface WarmupStep {
  id: string;
  label: string;
  done: boolean;
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isWarmup, setIsWarmup] = useState(searchParams?.get('warmup') === 'true');
  const setupChannel = searchParams?.get('setup') || '';
  const [showSetupDrawer, setShowSetupDrawer] = useState(
    Boolean(searchParams?.get('setup')) && searchParams?.get('warmup') !== 'true'
  );
  const [provisionProgress, setProvisionProgress] = useState(0);
  const [warmupSteps, setWarmupSteps] = useState<WarmupStep[]>([
    { id: 'employees', label: 'Your AI employees are ready', done: false },
    { id: 'nango', label: 'Tool connections', done: false },
    { id: 'pack', label: 'Starter skills chosen for your business', done: false },
  ]);
  const [askQuery, setAskQuery] = useState('');
  const [liveMessage, setLiveMessage] = useState('');

  const [stats, setStats] = useState<{
    userEmail?: string;
    conversationCount?: number;
    conversationChangePct?: number | null;
    avgResponseMs?: number | null;
    aiAutomationRate?: number | null;
    needsAttentionCount?: number;
    channelCount?: number;
    aiEmployeeCount?: number;
    aiEmployees?: Array<{ id: string; name: string; role: string; description?: string }>;
  } | null>(null);
  const [infraStatus, setInfraStatus] = useState<'healthy' | 'degraded' | 'unhealthy' | 'unknown'>(
    'unknown'
  );
  const [needsAttention, setNeedsAttention] = useState<
    Array<{ id: string; subject?: string; channel?: string; snippet?: string }>
  >([]);
  const [pendingPlans, setPendingPlans] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  useEffect(() => {
    if (!isWarmup) return;
    let cancelled = false;
    let ticks = 0;
    const MAX_TICKS = 24; // 24 * 2.5s ≈ 60s hard stop
    const tick = async () => {
      ticks += 1;
      if (ticks > MAX_TICKS) {
        if (!cancelled) {
          setIsWarmup(false);
          setLiveMessage('Provisioning timed out — open Employees or Integrations to finish setup');
        }
        return;
      }
      try {
        const [empRes, statsRes, integRes, packsRes, onboardRes] = await Promise.all([
          fetch('/api/employees'),
          fetch('/api/dashboard/stats'),
          fetch('/api/integrations'),
          fetch('/api/packs'),
          fetch('/api/org/onboarding'),
        ]);
        if (cancelled) return;

        if (
          empRes.status === 401 ||
          statsRes.status === 401 ||
          integRes.status === 401 ||
          packsRes.status === 401 ||
          onboardRes.status === 401
        ) {
          window.location.href = '/login';
          return;
        }

        const empData = empRes.ok ? await empRes.json() : { employees: [] };
        const statsData = statsRes.ok ? await statsRes.json() : {};
        const integData = integRes.ok ? await integRes.json() : null;
        const packsData = packsRes.ok ? await packsRes.json() : null;
        const onboardData = onboardRes.ok ? await onboardRes.json() : null;

        const employeesReady = Array.isArray(empData.employees) && empData.employees.length > 0;
        const nangoReady = Boolean(
          integData &&
            (Array.isArray(integData.integrations) ||
              typeof integData.connectedApps === 'number' ||
              integData.stats)
        );
        const packReady = Boolean(
          (packsData && (packsData.installed || packsData.packs || packsData.status === 'OK')) ||
            (onboardData && Array.isArray(onboardData.recommendedPacks) && onboardData.recommendedPacks.length > 0)
        );

        const nextSteps: WarmupStep[] = [
          { id: 'employees', label: 'Your AI employees are ready', done: employeesReady },
          { id: 'nango', label: 'Tool connections are ready', done: nangoReady },
          { id: 'pack', label: 'Starter skills chosen for your business', done: packReady },
        ];
        setWarmupSteps(nextSteps);
        const doneCount = nextSteps.filter((s) => s.done).length;
        const pct = Math.round((doneCount / nextSteps.length) * 100);
        setProvisionProgress(pct);
        setLiveMessage(`Provisioning ${pct}% — ${doneCount} of ${nextSteps.length} checks passed`);

        if (employeesReady && (nangoReady || packReady || Number(statsData.channelCount || 0) >= 0)) {
          if (employeesReady) {
            setIsWarmup(false);
            setLiveMessage('Workspace is online');
            if (searchParams?.get('setup')) {
              setShowSetupDrawer(true);
            }
          }
        }
      } catch (err) {
        console.error(err);
      }
    };
    tick();
    const timer = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isWarmup, searchParams]);

  useEffect(() => {
    if (!isWarmup && setupChannel) {
      setShowSetupDrawer(true);
    }
  }, [isWarmup, setupChannel]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard/stats');
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!res.ok) throw new Error(`stats ${res.status}`);
      const data = await res.json();
      setStats(data);
      setStatsError(null);
    } catch (err) {
      console.error(err);
      setStatsError('Failed to load briefing stats');
    } finally {
      setLoading(false);
    }

    try {
      const res = await fetch('/api/conversations?status=needs_attention');
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      const data = res.ok ? await res.json() : { conversations: [] };
      setNeedsAttention(data.conversations || []);
    } catch (err) {
      console.error(err);
    }

    try {
      const res = await fetch('/api/ask-ai/plan');
      const data = res.ok ? await res.json() : { plans: [] };
      const plans = Array.isArray(data.plans) ? data.plans : [];
      setPendingPlans(plans.filter((p: { status?: string }) => p.status === 'pending').length);
    } catch {
      setPendingPlans(0);
    }

    try {
      const res = await fetch('/api/health/ready', { cache: 'no-store' });
      const data = res.ok || res.status === 503 ? await res.json() : null;
      const status = data?.status;
      if (status === 'healthy' || status === 'degraded' || status === 'unhealthy') {
        setInfraStatus(status);
      } else {
        setInfraStatus('unknown');
      }
    } catch {
      setInfraStatus('unknown');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Quiet refetch: setLoading only ever goes false here, so no loading flash.
  useLiveRefresh({ events: HOME_EVENTS, refetch: load });

  if (loading) {
    return <div className="p-8 text-center text-slate-500 font-serif">Loading briefing...</div>;
  }

  if (statsError && !stats) {
    return (
      <div className="max-w-lg mx-auto p-8 text-center space-y-3">
        <p className="text-sm text-red-700">{statsError}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="px-4 py-2 rounded-xl bg-amber-500 text-heading text-sm font-semibold"
        >
          Retry
        </button>
      </div>
    );
  }

  const firstName = stats?.userEmail
    ? stats.userEmail.split('@')[0].charAt(0).toUpperCase() + stats.userEmail.split('@')[0].slice(1)
    : 'Owner';

  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-4">
      <LiveRegion message={liveMessage} />
      <div
        className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-xl border text-xs ${
          infraStatus === 'unhealthy'
            ? 'bg-red-50 border-red-200 text-red-800'
            : infraStatus === 'degraded'
              ? 'bg-amber-50 border-amber-200 text-amber-900'
              : infraStatus === 'healthy'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-cream-100 border-cream-300 text-slate-600'
        }`}
      >
        <span>
          {infraStatus === 'healthy'
            ? 'Everything is running'
            : infraStatus === 'degraded'
              ? 'Some services are slow'
              : infraStatus === 'unhealthy'
                ? 'Some services are down'
                : 'Checking status…'}
          {stats?.channelCount != null ? ` · ${stats.channelCount} ${stats.channelCount === 1 ? 'channel' : 'channels'} connected` : ''}
          {stats?.aiEmployeeCount != null ? ` · ${stats.aiEmployeeCount} AI ${stats.aiEmployeeCount === 1 ? 'employee' : 'employees'}` : ''}
        </span>
        <Link href="/connectors" className="font-semibold underline-offset-2 hover:underline">
          Manage connectors →
        </Link>
      </div>
      <ApprovalsCallout />
      <GetStarted channelCount={stats ? (stats.channelCount ?? 0) : null} />
      <DailyDigest />
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">
            Daily briefing, {firstName}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            What happened in your business, and what needs you.
          </p>
        </div>
        {pendingPlans > 0 ? (
          <Link
            href="/plans"
            className="text-xs font-semibold px-3 py-2 rounded-xl bg-amber-500/15 text-amber-900 border border-amber-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {pendingPlans} plan{pendingPlans === 1 ? '' : 's'} waiting
          </Link>
        ) : null}
      </div>

      {isWarmup ? (
        <div className="bg-white border-2 border-amber-500/30 rounded-3xl p-6 sm:p-8 shadow-lg relative overflow-hidden">
          <div className="flex items-start space-x-5">
            <div className="p-4 bg-amber-500/20 rounded-2xl shrink-0">
              <Sparkles className="w-8 h-8 text-amber-700 animate-spin" />
            </div>
            <div className="space-y-3 flex-1 min-w-0">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <h2 className="text-xl font-serif font-bold text-heading">Your business is coming online…</h2>
                <StatusBadge label={`${provisionProgress}% complete`} tone="warning" />
              </div>
              <p className="text-slate-600 text-sm">
                This reflects what is really ready, not a timer.
              </p>
              <div className="w-full bg-cream-200 h-3 rounded-full overflow-hidden">
                <div
                  className="bg-amber-500 h-full transition-all duration-700 ease-out"
                  style={{ width: `${provisionProgress}%` }}
                />
              </div>
              <ul className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 text-xs font-medium text-slate-600">
                {warmupSteps.map((step) => (
                  <li key={step.id} className="flex items-center space-x-2">
                    {step.done ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-700" aria-hidden="true" />
                    ) : (
                      <CircleDashed className="w-4 h-4 text-slate-400" aria-hidden="true" />
                    )}
                    <span>
                      {step.label}
                      <span className="sr-only">{step.done ? ' done' : ' pending'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ) : null}

      {showSetupDrawer && !isWarmup ? (
        <div className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-serif font-bold text-heading">Connect a channel to go live</h2>
              <p className="text-sm text-slate-600 mt-1">
                Setup chose your channels{setupChannel ? ` (next: ${setupChannel})` : ''}. No messages arrive until you
                connect them, and nothing shows as connected before then.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowSetupDrawer(false)}
              className="text-xs font-semibold text-slate-500 hover:text-heading"
            >
              Dismiss
            </button>
          </div>
          <ol className="text-sm text-slate-600 list-decimal pl-5 space-y-1">
            <li>Open Connectors to connect WhatsApp, or Integrations to connect Gmail.</li>
            <li>Sign in to the app when asked (or paste your Meta credentials for WhatsApp on Connectors).</li>
            <li>Confirm the channel status shows connected — not pending.</li>
          </ol>
          <Link
            href="/connectors"
            className="inline-flex items-center px-4 py-2 rounded-xl bg-amber-500 text-heading text-sm font-semibold"
          >
            Open Connectors →
          </Link>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 space-y-8">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Conversations</span>
              <div className="text-3xl font-bold text-heading">{stats?.conversationCount ?? 0}</div>
              <span className="text-xs text-slate-500 font-medium">
                {stats?.conversationChangePct == null
                  ? 'No prior-day volume to compare'
                  : `${stats.conversationChangePct >= 0 ? '+' : ''}${stats.conversationChangePct}% vs yesterday`}
              </span>
            </div>

            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Avg Response</span>
              <div className="text-3xl font-bold text-heading">
                {stats?.avgResponseMs ? (stats.avgResponseMs / 1000).toFixed(1) + 's' : 'N/A'}
              </div>
              <span className="text-xs text-slate-500 font-medium">
                {stats?.aiAutomationRate != null ? `${stats.aiAutomationRate}% AI automated (7d)` : 'No automation sample yet'}
              </span>
            </div>

            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Needs Attention</span>
              <div className="text-3xl font-bold text-heading">{stats?.needsAttentionCount ?? 0}</div>
              <span className="text-xs text-slate-500 font-medium">Human review queued</span>
            </div>

            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Channels Connected</span>
              <div className="text-3xl font-bold text-heading">{stats?.channelCount ?? 0}</div>
              <span className="text-xs text-slate-500 font-medium">Active channels</span>
            </div>
          </div>

          <div className="bg-white border border-cream-300 rounded-3xl p-6 space-y-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-serif font-bold text-heading">AI Employee Roster</h2>
              <Link
                href="/employees"
                className="text-xs font-semibold text-amber-800 hover:text-amber-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-lg px-2 py-1"
              >
                View all{stats?.aiEmployeeCount != null ? ` (${stats.aiEmployeeCount})` : ''} →
              </Link>
            </div>
            {stats?.aiEmployees && stats.aiEmployees.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {stats.aiEmployees.map((emp) => (
                  <div key={emp.id} className="p-4 rounded-2xl bg-cream-100 border border-cream-300 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-heading">{emp.name}</span>
                      <StatusBadge label={emp.role} tone="warning" />
                    </div>
                    <p className="text-xs text-slate-500">{emp.description || 'No description'}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center bg-cream-50 border border-dashed border-cream-300 rounded-2xl">
                <p className="text-slate-500">
                  No AI employees configured yet — set them up in the{' '}
                  <Link href="/employees" className="text-amber-700 underline font-semibold hover:text-amber-800">
                    Employees section
                  </Link>
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-4 space-y-8">
          <div className="bg-white border border-cream-300 rounded-3xl p-6 space-y-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-serif font-bold text-heading">Needs Attention</h2>
              <span className="w-6 h-6 rounded-full bg-amber-500 text-heading text-xs font-bold flex items-center justify-center">
                {needsAttention.length}
              </span>
            </div>

            <div className="space-y-3">
              {needsAttention.length > 0 ? (
                needsAttention.map((conv) => (
                  <Link
                    key={conv.id}
                    href={`/conversations?id=${encodeURIComponent(conv.id)}`}
                    className="block p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-2xl space-y-1 hover:bg-amber-500/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                  >
                    <div className="flex items-center justify-between text-xs font-semibold text-amber-800">
                      <span className="flex items-center space-x-1">
                        <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{conv.subject || 'Needs Review'}</span>
                      </span>
                      <StatusBadge label={conv.channel || 'System'} tone="warning" />
                    </div>
                    <p className="text-xs text-slate-700">{conv.snippet || 'This conversation requires human review.'}</p>
                  </Link>
                ))
              ) : (
                <div className="p-4 text-center bg-cream-50 border border-dashed border-cream-300 rounded-2xl text-slate-500 text-sm">
                  No conversations need attention.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <form
        className="bg-white border border-cream-300 rounded-3xl p-4 shadow-lg flex items-center space-x-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (askQuery.trim()) {
            router.push('/ask-ai?q=' + encodeURIComponent(askQuery.trim()));
          }
        }}
      >
        <Sparkles className="w-6 h-6 text-amber-700 shrink-0 ml-2" aria-hidden="true" />
        <input
          type="text"
          value={askQuery}
          onChange={(e) => setAskQuery(e.target.value)}
          placeholder="Ask your business anything"
          aria-label="Ask your business"
          className="flex-1 min-w-0 bg-transparent border-none focus:outline-none text-heading font-medium placeholder:text-slate-400"
        />
        <button
          type="submit"
          className="p-3 bg-amber-500 hover:bg-amber-600 text-heading rounded-2xl transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
          aria-label="Send question"
        >
          <Send className="w-5 h-5" />
        </button>
      </form>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-slate-500 font-serif">Loading briefing...</div>}>
      <HomeContent />
    </Suspense>
  );
}
