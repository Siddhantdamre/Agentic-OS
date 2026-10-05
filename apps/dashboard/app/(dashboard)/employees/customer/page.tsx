'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { HeartHandshake, BookOpen } from 'lucide-react';
import { LiveRegion } from '@/components/a11y';
import { DecisionCardPanel, type CustomerDecisionCard } from '@/components/customer/DecisionCardPanel';
import { OpenLoopsDrawer } from '@/components/customer/OpenLoopsDrawer';
import { TeachKnowledgeGapModal } from '@/components/customer/TeachKnowledgeGapModal';
import { useRealtimeStream } from '@/lib/use-realtime-stream';
import { networkErrorMessage } from '@/lib/client-error';

const CUSTOMER_EVENTS = ['needs_attention', 'conversation_updated', 'message_received'] as const;

type KnowledgeGapCluster = {
  topic: string;
  count: number;
  examples?: string[];
  lastSeen?: string;
};

type CustomerBrief = {
  handled: number;
  atRisk: number;
  openLoops: number;
  attention: number;
  cards: Array<{
    id: string;
    status: string;
    card: CustomerDecisionCard | null;
    conversationId?: string | null;
  }>;
  cardsTotal?: number;
  cardsHasMore?: boolean;
  insights: Array<{ id: string; topic: string; sampleCount: number; recommendation: string | null }>;
  knowledgeGaps?: { clusters: KnowledgeGapCluster[]; totalQuestions: number };
};

export default function CustomerEmployeePage() {
  const [brief, setBrief] = useState<CustomerBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const [offset, setOffset] = useState(0);
  const [loopsOpen, setLoopsOpen] = useState(false);
  const [teachCluster, setTeachCluster] = useState<KnowledgeGapCluster | null>(null);
  const limit = 25;

  const load = useCallback(async (nextOffset = 0, append = false) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/employees/customer?limit=${limit}&offset=${nextOffset}`);
      if (!res.ok) throw new Error('We couldn’t load customer brief. Please try again.');
      const data = (await res.json()) as CustomerBrief;
      setBrief((prev) => ({
        handled: Number(data.handled || 0),
        atRisk: Number(data.atRisk || 0),
        openLoops: Number(data.openLoops || 0),
        attention: Number(data.attention || 0),
        cards: append && prev
          ? [...prev.cards, ...(Array.isArray(data.cards) ? data.cards : [])]
          : Array.isArray(data.cards) ? data.cards : [],
        cardsTotal: data.cardsTotal,
        cardsHasMore: data.cardsHasMore,
        insights: Array.isArray(data.insights) ? data.insights : [],
        knowledgeGaps: data.knowledgeGaps || { clusters: [], totalQuestions: 0 },
      }));
      setOffset(nextOffset);
      setError(null);
    } catch (err: unknown) {
      setError(networkErrorMessage(err, 'Failed to load customer brief'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(0, false);
  }, [load]);

  // Customer metrics move when conversations do; work items have no bus
  // event, so listen to the conversation events that are published.
  useRealtimeStream({
    events: CUSTOMER_EVENTS,
    onEvent: () => {
      load(0, false);
      setLive('Customer metrics updated');
    },
  });

  const cards = (brief?.cards || []).filter((row) => row.card);
  const gaps = brief?.knowledgeGaps?.clusters || [];

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      <LiveRegion message={live} />
      <div>
        <h1 className="text-3xl font-serif font-bold text-heading">Customer</h1>
        <p className="text-slate-500 text-sm mt-1">Resolve needs, not just replies</p>
      </div>
      {loading && !brief ? (
        <div className="h-24 bg-cream-200/50 rounded-2xl animate-pulse border border-cream-300" />
      ) : error && !brief ? (
        <p className="text-sm text-amber-800">{error}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Handled this week" value={brief?.handled || 0} />
          <Stat label="Need you" value={brief?.attention || 0} />
          <button
            type="button"
            onClick={() => setLoopsOpen(true)}
            className="text-left bg-cream-200/70 border border-cream-300 p-4 rounded-2xl hover:border-amber-400 transition"
          >
            <p className="text-2xl font-serif font-bold text-heading">{brief?.openLoops || 0}</p>
            <p className="text-xs text-slate-500 mt-1">Open loops — click to inspect</p>
          </button>
          <Stat label="At risk" value={brief?.atRisk || 0} />
        </div>
      )}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <HeartHandshake className="w-4 h-4 text-heading" />
          <h2 className="font-serif font-bold text-heading text-lg">Decision cards</h2>
        </div>
        {cards.length === 0 ? (
          <p className="text-sm text-slate-500">No judgment calls waiting.</p>
        ) : (
          <div className="space-y-3">
            {cards.map((row) => (
              <DecisionCardPanel
                key={row.id}
                workItemId={row.id}
                card={row.card as CustomerDecisionCard}
                conversationId={row.conversationId}
                onResolved={(action) => {
                  setLive(action === 'approve' ? 'Approved' : 'Held');
                  load(0, false);
                }}
              />
            ))}
            {brief?.cardsHasMore && (
              <button
                type="button"
                disabled={loading}
                onClick={() => load(offset + limit, true)}
                className="w-full text-sm font-semibold py-2 rounded-xl border border-cream-300 bg-white hover:bg-cream-100 disabled:opacity-50"
              >
                Load more cards
              </button>
            )}
          </div>
        )}
      </section>
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-heading" />
          <h2 className="font-serif font-bold text-heading text-lg">Knowledge gaps</h2>
        </div>
        {gaps.length === 0 ? (
          <p className="text-sm text-slate-500">
            No clustered unanswered questions yet
            {brief?.knowledgeGaps?.totalQuestions
              ? ` (${brief.knowledgeGaps.totalQuestions} raw suppressions logged).`
              : '.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {gaps.map((cluster) => (
              <li key={`${cluster.topic}-${cluster.count}`} className="bg-white border border-cream-300 rounded-2xl p-4">
                <p className="text-sm font-semibold text-heading">{cluster.topic}</p>
                <p className="text-xs text-slate-500 mt-1">
                  Asked {cluster.count} time{cluster.count === 1 ? '' : 's'} without a grounded answer
                </p>
                {(cluster.examples || []).length > 0 && (
                  <p className="text-xs text-slate-600 mt-2">{cluster.examples!.slice(0, 2).join(' · ')}</p>
                )}
                <button
                  type="button"
                  onClick={() => setTeachCluster(cluster)}
                  className="mt-3 text-xs font-semibold px-3 py-1.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-heading"
                >
                  Teach AI answer
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="font-serif font-bold text-heading text-lg">This week&apos;s friction</h2>
        {(brief?.insights || []).length === 0 ? (
          <p className="text-sm text-slate-500">No clustered topics yet.</p>
        ) : (
          <ul className="space-y-2">
            {(brief?.insights || []).map((row) => (
              <li key={row.id} className="bg-white border border-cream-300 rounded-2xl p-4">
                <p className="text-sm font-semibold text-heading">{row.topic}</p>
                <p className="text-xs text-slate-500 mt-1">{row.sampleCount} mentions</p>
                {row.recommendation && <p className="text-sm text-slate-600 mt-2">{row.recommendation}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <OpenLoopsDrawer
        isOpen={loopsOpen}
        onClose={() => setLoopsOpen(false)}
        onUpdated={() => load(0, false)}
      />
      <TeachKnowledgeGapModal
        cluster={teachCluster}
        onClose={() => setTeachCluster(null)}
        onSaved={() => setLive('Answer saved to knowledge base')}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-cream-200/70 border border-cream-300 p-4 rounded-2xl">
      <p className="text-2xl font-serif font-bold text-heading">{value}</p>
      <p className="text-xs text-slate-500 mt-1">{label}</p>
    </div>
  );
}
