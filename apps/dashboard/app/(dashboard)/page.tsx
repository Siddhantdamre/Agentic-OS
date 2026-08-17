'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Sparkles, AlertTriangle, Send, CheckCircle2, CircleDashed } from 'lucide-react';
import { LiveRegion, StatusBadge } from '@/components/a11y';

export const dynamic = 'force-dynamic';

interface WarmupStep {
  id: string;
  label: string;
  done: boolean;
}

function HomeContent() {
  const searchParams = useSearchParams();
  const [isWarmup, setIsWarmup] = useState(searchParams?.get('warmup') === 'true');
  const [provisionProgress, setProvisionProgress] = useState(0);
  const [warmupSteps, setWarmupSteps] = useState<WarmupStep[]>([
    { id: 'employees', label: 'AI employees in roster', done: false },
    { id: 'nango', label: 'Nango connector registry', done: false },
    { id: 'pack', label: 'Pack recommendation recorded', done: false },
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
    aiEmployees?: Array<{ id: string; name: string; role: string; description?: string }>;
  } | null>(null);
  const [needsAttention, setNeedsAttention] = useState<
    Array<{ id: string; subject?: string; channel?: string; snippet?: string }>
  >([]);
  const [pendingPlans, setPendingPlans] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isWarmup) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [empRes, statsRes, integRes, packsRes, onboardRes] = await Promise.all([
          fetch('/api/employees'),
          fetch('/api/dashboard/stats'),
          fetch('/api/integrations'),
          fetch('/api/packs'),
          fetch('/api/org/onboarding'),
        ]);
        if (cancelled) return;

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
          { id: 'employees', label: 'AI employees in roster', done: employeesReady },
          { id: 'nango', label: 'Nango connector registry reachable', done: nangoReady },
          { id: 'pack', label: 'Pack recommendation recorded', done: packReady },
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
  }, [isWarmup]);

  useEffect(() => {
    fetch('/api/dashboard/stats')
      .then((res) => res.json())
      .then((data) => {
        setStats(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });

    fetch('/api/conversations?status=needs_attention')
      .then((res) => res.json())
      .then((data) => {
        setNeedsAttention(data.conversations || []);
      })
      .catch((err) => console.error(err));

    fetch('/api/ask-ai/plan')
      .then((res) => (res.ok ? res.json() : { plans: [] }))
      .then((data) => {
        const plans = Array.isArray(data.plans) ? data.plans : [];
        setPendingPlans(plans.filter((p: { status?: string }) => p.status === 'pending').length);
      })
      .catch(() => setPendingPlans(0));
  }, []);

  if (loading) {
    return <div className="p-8 text-center text-slate-500 font-serif">Loading briefing...</div>;
  }

  const firstName = stats?.userEmail
    ? stats.userEmail.split('@')[0].charAt(0).toUpperCase() + stats.userEmail.split('@')[0].slice(1)
    : 'Owner';

  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-4">
      <LiveRegion message={liveMessage} />
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">
            Daily briefing, {firstName}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Numbers below come from your org stats. Empty queues stay empty.
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
              <Sparkles className="w-8 h-8 text-amber-600 animate-spin" />
            </div>
            <div className="space-y-3 flex-1 min-w-0">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <h2 className="text-xl font-serif font-bold text-heading">Your business is coming online…</h2>
                <StatusBadge label={`${provisionProgress}% complete`} tone="warning" />
              </div>
              <p className="text-slate-600 text-sm">
                Progress is from live employee, Nango, and pack checks — not a timer.
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
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-hidden="true" />
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
                {stats?.aiAutomationRate != null ? `${stats.aiAutomationRate}% AI automated` : 'No automation sample yet'}
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
            <h2 className="text-lg font-serif font-bold text-heading">Active AI Employee Roster</h2>
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
                <p className="text-slate-500">No AI employees configured yet — set them up in the Employees section</p>
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
                  <div key={conv.id} className="p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-2xl space-y-1">
                    <div className="flex items-center justify-between text-xs font-semibold text-amber-800">
                      <span className="flex items-center space-x-1">
                        <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{conv.subject || 'Needs Review'}</span>
                      </span>
                      <StatusBadge label={conv.channel || 'System'} tone="warning" />
                    </div>
                    <p className="text-xs text-slate-700">{conv.snippet || 'This conversation requires human review.'}</p>
                  </div>
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
            window.location.href = '/ask-ai?q=' + encodeURIComponent(askQuery);
          }
        }}
      >
        <Sparkles className="w-6 h-6 text-amber-600 shrink-0 ml-2" aria-hidden="true" />
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
