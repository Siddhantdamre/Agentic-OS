'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Lightbulb,
  Sparkles,
  ArrowRight,
  TrendingUp,
  ShieldAlert,
  Zap,
  Loader2,
  CheckCircle2,
} from 'lucide-react';

type InsightCardType = 'growth' | 'efficiency' | 'integration' | 'attention';

interface InsightItem {
  id: string;
  metricId: string;
  category: string;
  title: string;
  narrative?: string;
  description?: string;
  value: number;
  status: 'ok' | 'gap' | 'stale';
  impact: string;
  actionLabel: string;
  actionHref: string;
  recommendedWorkflow?: string | null;
  type: InsightCardType;
}

interface ConfirmRejectDrift {
  confirmed: number;
  rejected: number;
  rejectRate: number | null;
  highRejectFlag: boolean;
  sampleSize: number;
}

export default function InsightPage() {
  const [insights, setInsights] = useState<InsightItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [weeklyCost, setWeeklyCost] = useState<number | null>(null);
  const [confirmReject, setConfirmReject] = useState<ConfirmRejectDrift | null>(null);
  const [enqueueingId, setEnqueueingId] = useState<string | null>(null);
  const [started, setStarted] = useState<Record<string, { workflowId: string; namedWorkflow: string }>>({});
  const [actionError, setActionError] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch('/api/insight')
      .then((res) => res.json())
      .then((data) => {
        setInsights(data.insights || []);
        if (data.weeklyCost && typeof data.weeklyCost.weeklyCostUsd === 'number') {
          setWeeklyCost(data.weeklyCost.weeklyCostUsd);
        }
        if (data.confirmReject) setConfirmReject(data.confirmReject);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleReviewAction = async (item: InsightItem) => {
    if (!item.recommendedWorkflow || item.status === 'gap') return;
    setEnqueueingId(item.id);
    setActionError((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    try {
      const res = await fetch('/api/insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metricId: item.metricId, namedWorkflow: item.recommendedWorkflow }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError((prev) => ({ ...prev, [item.id]: data.error || 'Failed to start workflow' }));
        return;
      }
      setStarted((prev) => ({
        ...prev,
        [item.id]: { workflowId: data.workflowId, namedWorkflow: data.namedWorkflow || data.workflowName },
      }));
    } catch (err: unknown) {
      setActionError((prev) => ({
        ...prev,
        [item.id]: err instanceof Error ? err.message : 'Failed to start workflow',
      }));
    } finally {
      setEnqueueingId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold text-heading">AI Business Insights</h1>
          <p className="text-slate-500 text-sm mt-1">
            Scheduled cards from the metrics registry SQL. Review Action starts a named Temporal
            workflow — not a free-form agent, and not an LLM scan of messages.
          </p>
        </div>

        <div className="flex items-center space-x-2 px-3 py-1.5 bg-amber-500/10 text-amber-700 rounded-full border border-amber-500/20 text-xs font-bold">
          <Sparkles className="w-4 h-4 text-amber-600" />
          <span>Semantic metrics</span>
        </div>
      </div>

      {(weeklyCost !== null || confirmReject?.highRejectFlag) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {weeklyCost !== null && (
            <div className="bg-white border border-cream-300 rounded-2xl p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Weekly LLM cost</p>
              <p className="text-2xl font-serif font-bold text-heading mt-1">${weeklyCost.toFixed(4)}</p>
              <p className="text-xs text-slate-500 mt-1">From this workspace’s own activity. Failed/notConnected actions are not counted as success.</p>
            </div>
          )}
          {confirmReject?.highRejectFlag && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-amber-800">Confirm-reject drift</p>
              <p className="text-sm text-amber-900 mt-1">
                {confirmReject.rejected} of {confirmReject.sampleSize} plans were rejected
                {confirmReject.rejectRate != null ? ` (${Math.round(confirmReject.rejectRate * 100)}%)` : ''}.
                Promotion stays human-named — nothing is trained silently.
              </p>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-36 bg-cream-200/50 rounded-3xl animate-pulse border border-cream-300" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {insights.length === 0 ? (
            <p className="text-sm text-slate-500">
              No insight cards — the registry returned no metric points for this org.
            </p>
          ) : null}
          {insights.map((item) => {
            const queued = started[item.id];
            const err = actionError[item.id];
            const canEnqueue = Boolean(item.recommendedWorkflow) && item.status !== 'gap';
            return (
              <div
                key={item.id}
                className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm hover:shadow-md transition-all flex items-center justify-between space-x-6"
              >
                <div className="flex items-start space-x-4">
                  <div
                    className={`p-3.5 rounded-2xl shrink-0 ${
                      item.type === 'growth'
                        ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20'
                        : item.type === 'efficiency'
                          ? 'bg-amber-500/10 text-amber-600 border border-amber-500/20'
                          : item.type === 'attention'
                            ? 'bg-red-500/10 text-red-600 border border-red-500/20'
                            : 'bg-blue-500/10 text-blue-600 border border-blue-500/20'
                    }`}
                  >
                    {(() => {
                      switch (item.type) {
                        case 'growth':
                          return <TrendingUp className="w-6 h-6" />;
                        case 'efficiency':
                          return <Zap className="w-6 h-6" />;
                        case 'integration':
                          return <Lightbulb className="w-6 h-6" />;
                        case 'attention':
                          return <ShieldAlert className="w-6 h-6" />;
                        default: {
                          const _exhaustive: never = item.type;
                          return _exhaustive;
                        }
                      }
                    })()}
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center space-x-3">
                      <span className="text-[11px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-cream-200 text-slate-700">
                        {item.category}
                      </span>
                      <span className="text-xs font-semibold text-emerald-600">Impact: {item.impact}</span>
                      <span className="text-[10px] font-mono text-slate-400">{item.metricId}</span>
                    </div>

                    <h3 className="text-lg font-serif font-bold text-heading">{item.title}</h3>
                    <p className="text-xs text-slate-600 max-w-2xl leading-relaxed">
                      {item.narrative || item.description}
                    </p>
                    {queued && (
                      <p className="text-[11px] text-emerald-700 flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {queued.namedWorkflow} started — Temporal id {queued.workflowId}
                      </p>
                    )}
                    {err && <p className="text-[11px] text-red-600">{err}</p>}
                  </div>
                </div>

                {canEnqueue ? (
                  <button
                    type="button"
                    onClick={() => handleReviewAction(item)}
                    disabled={enqueueingId === item.id || Boolean(queued)}
                    className="px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-heading text-xs font-bold rounded-2xl flex items-center space-x-2 shrink-0 transition-colors shadow-sm disabled:opacity-50"
                  >
                    {enqueueingId === item.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <ArrowRight className="w-4 h-4" />
                    )}
                    <span>{queued ? 'Queued' : item.actionLabel}</span>
                  </button>
                ) : (
                  <Link
                    href={item.actionHref}
                    className="px-4 py-2.5 bg-amber-500 hover:bg-amber-600 text-heading text-xs font-bold rounded-2xl flex items-center space-x-2 shrink-0 transition-colors shadow-sm"
                  >
                    <span>{item.actionLabel}</span>
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
