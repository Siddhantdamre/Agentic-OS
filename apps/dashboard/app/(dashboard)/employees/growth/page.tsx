'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { TrendingUp, Search } from 'lucide-react';
import {
  OpportunityCard,
  type GrowthOpportunityPayload,
  type OpportunityDecision,
  type RejectionReasonId,
} from '@/components/growth/OpportunityCard';
import { LiveRegion } from '@/components/a11y';
import { useLiveRefresh } from '@/lib/use-live-refresh';

type GrowthOpportunity = {
  id: string;
  status: string;
  card: GrowthOpportunityPayload;
};

type GrowthBrief = {
  opportunities: GrowthOpportunity[];
  signalCount: number;
  visitorCount: number;
  pipelineRoi?: {
    rows: number;
    estimatedValueCents: number;
    byStage: Record<string, number>;
  };
};

const GROWTH_EVENTS = [
  'inquiry_updated',
  'conversation_updated',
  'plan_updated',
  'work_item_updated',
] as const;

export default function GrowthPage() {
  const [brief, setBrief] = useState<GrowthBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const [matching, setMatching] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch('/api/growth/brief');
      if (!res.ok) throw new Error(`Failed to load growth brief (${res.status})`);
      const data = (await res.json()) as GrowthBrief;
      setBrief({
        opportunities: Array.isArray(data.opportunities) ? data.opportunities : [],
        signalCount: Number(data.signalCount || 0),
        visitorCount: Number(data.visitorCount || 0),
        pipelineRoi: data.pipelineRoi,
      });
      setError(null);
    } catch (err: unknown) {
      // A failed background refresh keeps the last good brief on screen.
      if (quiet) console.error('[growth] live refresh failed', err);
      else setError(err instanceof Error ? err.message : 'Failed to load growth brief');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useLiveRefresh({ events: GROWTH_EVENTS, refetch: () => load(true) });

  const decide = async (id: string, decision: OpportunityDecision, reason?: RejectionReasonId) => {
    const action =
      decision === 'approve' ? 'approve' : decision === 'snooze' ? 'snooze' : 'reject';
    const res = await fetch(`/api/growth/opportunities/${id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, reason: reason || null }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      outreachDispatched?: boolean;
      outreachBlockedReason?: string | null;
    };
    if (!res.ok) {
      throw new Error(typeof data.error === 'string' ? data.error : 'Decision failed');
    }
    if (action === 'approve') {
      setLive(
        data.outreachDispatched
          ? 'Outreach sent after approval'
          : data.outreachBlockedReason || 'Approved — outreach pending connector',
      );
    } else {
      setLive(action === 'snooze' ? 'Snoozed' : 'Passed');
    }
    await load();
  };

  const runListingMatch = async () => {
    setMatching(true);
    try {
      const res = await fetch('/api/growth/listings/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Match failed');
      setLive(
        typeof data.message === 'string'
          ? data.message
          : `Queued ${Array.isArray(data.createdWorkItems) ? data.createdWorkItems.length : 0} cards for approval`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Match failed');
    } finally {
      setMatching(false);
    }
  };

  const opportunities = brief?.opportunities || [];
  const roiCents = brief?.pipelineRoi?.estimatedValueCents ?? 0;

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      <LiveRegion message={live} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-serif font-bold text-heading">Growth</h1>
          <p className="text-slate-500 text-sm mt-1">
            Approve outreach before anything is sent — no auto-send.
          </p>
        </div>
        <button
          type="button"
          disabled={matching}
          onClick={runListingMatch}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl bg-amber-500 hover:bg-amber-600 text-heading disabled:opacity-50"
        >
          <Search className="w-3.5 h-3.5" />
          {matching ? 'Matching…' : 'Match listings → inquiries'}
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="bg-cream-200/70 border border-cream-300 p-4 rounded-2xl">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Signals</span>
          <div className="text-2xl font-bold text-heading mt-1">{loading ? '—' : brief?.signalCount ?? 0}</div>
        </div>
        <div className="bg-cream-200/70 border border-cream-300 p-4 rounded-2xl">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Visitors</span>
          <div className="text-2xl font-bold text-heading mt-1">{loading ? '—' : brief?.visitorCount ?? 0}</div>
        </div>
        <div className="bg-cream-200/70 border border-cream-300 p-4 rounded-2xl col-span-2 md:col-span-1">
          <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Attributed pipeline</span>
          <div className="text-2xl font-bold text-heading mt-1">
            {loading ? '—' : `$${(roiCents / 100).toLocaleString()}`}
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            {brief?.pipelineRoi?.rows ?? 0} attribution rows (real table)
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="h-48 bg-cream-200/50 rounded-2xl animate-pulse border border-cream-300" />
          ))}
        </div>
      ) : opportunities.length === 0 ? (
        <div className="bg-white border-2 border-dashed border-cream-300 rounded-3xl p-10 text-center space-y-2">
          <TrendingUp className="w-10 h-10 text-slate-300 mx-auto" />
          <h3 className="text-lg font-serif font-bold text-heading">No opportunities need you</h3>
          <p className="text-sm text-slate-500">
            Run listing match or wait for scouted cards — sends still require Approve.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {opportunities.map((opp) => (
            <OpportunityCard
              key={opp.id}
              workItemId={opp.id}
              payload={opp.card}
              onDecision={(decision, reason) => decide(opp.id, decision, reason)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
