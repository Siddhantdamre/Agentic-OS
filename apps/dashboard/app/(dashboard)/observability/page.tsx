'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { SilentMetric } from '@/lib/employee-observability';
import type { FirstObservation, TrajectorySnapshot } from '@/lib/onboarding-rollout';
import { toRolloutWeekViews } from '@/lib/onboarding-rollout';
import { useLiveRefresh } from '@/lib/use-live-refresh';
import { PendingDecisionCard, type PendingDecision } from '@/components/observability/PendingDecisionCard';
import { AgentHealthPanel } from '@/components/observability/AgentHealthPanel';
import { responseErrorMessage } from '@/lib/client-error';

const OBSERVABILITY_EVENTS = [
  'needs_attention',
  'conversation_updated',
  'plan_updated',
  'work_item_updated',
  'settings_updated',
] as const;

const LOAD_FAILED = 'We couldn’t load employee health just now. Please try again in a moment.';
const ACTION_FAILED = 'That didn’t work. Please try again.';

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function ObservabilityPage() {
  const [metrics, setMetrics] = useState<SilentMetric[]>([]);
  const [alerts, setAlerts] = useState(0);
  const [stage, setStage] = useState(0);
  const [killSwitch, setKillSwitch] = useState(false);
  const [observation, setObservation] = useState<FirstObservation | null>(null);
  const [trajectory, setTrajectory] = useState<TrajectorySnapshot | null>(null);
  const [decisions, setDecisions] = useState<PendingDecision[]>([]);
  const [query, setQuery] = useState('');
  const [explain, setExplain] = useState<Array<{ reasonSummary: string; confidence: number; decision: string }>>([]);
  const [backfillNote, setBackfillNote] = useState('');
  const [dispatchNote, setDispatchNote] = useState('');
  const [metricsFailed, setMetricsFailed] = useState(false);
  const [decisionsFailed, setDecisionsFailed] = useState(false);
  const [actionNote, setActionNote] = useState('');

  const refreshDispatchStatus = useCallback(() => {
    // dryRun: report configured vs not without POSTing to the webhook on every page load
    fetch('/api/observability/alerts/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    })
      .then(async (r) => {
        const data = await r.json().catch(() => null);
        if (r.status === 403) {
          setDispatchNote('Sending alerts to your team needs settings access.');
          return;
        }
        if (!r.ok || !data) {
          setDispatchNote(data?.error || 'Alert dispatch check failed.');
          return;
        }
        if (data.dispatched === false && data.reason === 'not_configured') {
          setDispatchNote('Alert delivery isn’t set up yet. Ask your administrator to turn it on.');
          return;
        }
        if (data.dispatched === false && data.reason === 'preview') {
          const n = Array.isArray(data.alerts) ? data.alerts.length : 0;
          setDispatchNote(`Alert delivery is set up — ${n} alert(s) ready (not sent yet).`);
          return;
        }
        if (data.dispatched) {
          setDispatchNote(`Last delivery: sent ${Array.isArray(data.alerts) ? data.alerts.length : 0} alert(s).`);
          return;
        }
        setDispatchNote('The last alert delivery didn’t go through.');
      })
      .catch(() => setDispatchNote('Alert dispatch check failed.'));
  }, []);

  const load = useCallback(() => {
    // Every request is caught: a dropped connection must never become an unhandled rejection, and a failed
    // metrics request must never be shown as "no problems".
    getJson('/api/observability/metrics')
      .then((data) => {
        setMetricsFailed(false);
        setMetrics(data.metrics || []);
        const alertCount = data.alertCount || 0;
        setAlerts(alertCount);
        setStage(data.rolloutStage || 0);
        setKillSwitch(Boolean(data.killSwitch));
        if (alertCount > 0) refreshDispatchStatus();
        else setDispatchNote('');
      })
      .catch(() => setMetricsFailed(true));
    // Optional panels: if they are unavailable the page simply omits them.
    getJson('/api/onboarding/observation').then((data) => data?.observation && setObservation(data.observation)).catch(() => undefined);
    getJson('/api/onboarding/trajectory').then((data) => data?.trajectory && setTrajectory(data.trajectory)).catch(() => undefined);
    getJson('/api/decisions')
      .then((data) => {
        setDecisionsFailed(false);
        setDecisions(data?.decisions || []);
      })
      .catch(() => setDecisionsFailed(true));
  }, [refreshDispatchStatus]);

  useEffect(() => { load(); }, [load]);

  // Quiet by construction: `load` only swaps state in place, no loading flag.
  useLiveRefresh({ events: OBSERVABILITY_EVENTS, refetch: load });

  const resolve = async (id: string, status: 'approved' | 'rejected') => {
    setActionNote('');
    try {
      const res = await fetch('/api/decisions', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status }) });
      if (!res.ok) setActionNote(await responseErrorMessage(res, ACTION_FAILED));
    } catch {
      setActionNote(ACTION_FAILED);
    }
    load();
  };

  const runExplain = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionNote('');
    try {
      const res = await fetch(`/api/agent/explain?q=${encodeURIComponent(query)}`);
      if (!res.ok) {
        setExplain([]);
        setActionNote(await responseErrorMessage(res, 'We couldn’t look that up. Please try again.'));
        return;
      }
      const data = await res.json();
      const rows = data.matches || data.decisions || [];
      setExplain(rows.map((row: Record<string, unknown>) => ({
        reasonSummary: String(row.reasonSummary || row.reason_summary || ''),
        confidence: Number(row.confidence ?? row.confidenceScore ?? 0),
        decision: String(row.decision || ''),
      })));
    } catch {
      setExplain([]);
      setActionNote('We couldn’t look that up. Please check your connection and try again.');
    }
  };

  const runBackfill = async () => {
    setBackfillNote('');
    try {
      const res = await fetch('/api/onboarding/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ windowDays: 30 }) });
      if (!res.ok) {
        setBackfillNote(await responseErrorMessage(res, 'We couldn’t import your history. Please try again.'));
        return;
      }
      const data = await res.json();
      setBackfillNote(`Imported ${data.job?.loopsImported || 0} closed loops and ${data.job?.wonImported || 0} won accounts. Nothing was chased.`);
    } catch {
      setBackfillNote('We couldn’t import your history. Please check your connection and try again.');
    }
  };

  const weeks = toRolloutWeekViews(stage);

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-16">
      <div>
        <h1 className="text-3xl font-serif font-bold text-heading">Employee health</h1>
        {metricsFailed ? (
          <p role="alert" className="text-sm text-red-700 mt-1">{LOAD_FAILED}</p>
        ) : (
          <p className="text-sm text-slate-500 mt-1">Zero is an alert. {alerts} metric{alerts === 1 ? '' : 's'} outside the healthy band.{killSwitch ? ' Kill switch is on — shadow only.' : ''}</p>
        )}
        {decisionsFailed && !metricsFailed ? (
          <p role="alert" className="text-sm text-red-700 mt-1">We couldn’t load the decisions waiting for you. Please refresh in a moment.</p>
        ) : null}
        {actionNote ? <p role="alert" className="text-sm text-red-700 mt-1">{actionNote}</p> : null}
        {!metricsFailed && alerts > 0 && dispatchNote ? (
          <p className="text-xs text-slate-500 mt-1">{dispatchNote}</p>
        ) : null}
      </div>
      <AgentHealthPanel />
      <div className="grid gap-3 md:grid-cols-2">
        {metrics.map((m) => (
          <div key={m.key} className={`rounded-2xl border p-4 ${m.status === 'alert' ? 'border-red-300 bg-red-50' : m.status === 'unknown' ? 'border-slate-200 bg-slate-50' : 'border-cream-300 bg-white'}`}>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">{m.label}</p>
            <p className="text-2xl font-serif text-heading mt-1">
              {m.value == null || m.status === 'unknown'
                ? 'No data'
                : m.unit === 'ratio'
                  ? `${Math.round(m.value * 100)}%`
                  : m.value.toFixed(2)}
            </p>
            {m.status === 'unknown' ? <p className="text-xs text-slate-500 mt-1">No observations in this window</p> : null}
            {m.alertReason ? <p className="text-xs text-red-700 mt-1">{m.alertReason}</p> : null}
          </div>
        ))}
      </div>
      {observation ? (
        <section className="rounded-3xl border border-cream-300 bg-white p-6 shadow-sm space-y-2">
          <p className="text-xs font-bold uppercase tracking-wider text-amber-700">First observation</p>
          <h2 className="font-serif text-xl text-heading">{observation.headline}</h2>
          <p className="text-sm text-slate-600">{observation.detail}</p>
        </section>
      ) : null}
      {trajectory ? (
        <section className="rounded-3xl border border-cream-300 bg-white p-6 shadow-sm space-y-2">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">How I am learning</p>
          <p className="text-sm text-heading font-medium">{trajectory.message}</p>
        </section>
      ) : null}
      <ol className="grid gap-3 sm:grid-cols-2">
        {weeks.map((week) => (
          <li key={week.week} className={`rounded-2xl border p-4 ${week.current ? 'border-amber-500 bg-amber-50' : 'border-cream-300 bg-white'}`}>
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">{week.label}</p>
            <h3 className="font-serif text-lg text-heading mt-1">{week.headline}</h3>
            <p className="text-sm text-slate-600 mt-1">{week.body}</p>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-3">
        <button type="button" onClick={runBackfill} className="px-5 py-2.5 bg-amber-500 text-heading text-xs font-bold rounded-xl">Backfill last 30 days</button>
        {backfillNote ? <p className="text-xs text-slate-600">{backfillNote}</p> : null}
      </div>
      <form onSubmit={runExplain} className="flex gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Why didn't you merge Acme Technologies?" className="flex-1 px-4 py-2.5 rounded-xl border border-cream-300 bg-white text-sm" />
        <button type="submit" className="px-4 py-2.5 bg-heading text-white text-xs font-bold rounded-xl">Explain</button>
      </form>
      {explain.map((row, i) => (
        <p key={`${row.decision}-${i}`} className="text-sm text-slate-700">{row.reasonSummary} ({row.decision})</p>
      ))}
      <div className="space-y-3">
        {decisions.map((d) => <PendingDecisionCard key={d.id} decision={d} onResolve={resolve} />)}
      </div>
    </div>
  );
}
