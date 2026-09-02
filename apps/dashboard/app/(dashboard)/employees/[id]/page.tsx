'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Shield, Clock, MessageSquare, Activity } from 'lucide-react';

/**
 * One AI employee, and what it has actually done.
 *
 * Everything here comes from a persisted row. Where there are no rows the page
 * says there are none rather than showing a plausible zero next to a metric
 * name that implies it was measured — this is the page that proves attribution
 * works, so a number nobody can trace would defeat it.
 */

interface ActionKind { action_kind: string; n: number; last_at: string | null }
interface Conversation {
  id: string; status: string; summary: string | null;
  contact_id: string | null; started_at: string; resolved_at: string | null;
}
interface RecentAction {
  action_kind: string; occurred_at: string; conversation_id: string | null;
  metadata: Record<string, unknown> | null; source_table: string; source_id: string;
}
interface EmployeeDetail {
  id: string; name: string; role: string; status: string;
  persona: string | null; tools: string[]; createdAt: string;
  conversationStats: { total: number; resolved: number; needs_attention: number; open: number };
  actionsByKind: ActionKind[];
  conversations: Conversation[];
  recentActions: RecentAction[];
}

// Same labels as the roster, so a tool does not change name between pages.
const TOOL_LABELS: Record<string, string> = {
  gmail: 'Gmail', whatsapp: 'WhatsApp', 'google-calendar': 'Google Calendar',
  'google-drive': 'Google Drive', 'google-docs': 'Google Docs', 'google-sheets': 'Google Sheets',
  hubspot: 'HubSpot CRM', github: 'GitHub', slack: 'Slack', notion: 'Notion',
  'meta-ads': 'Meta Ads', web_search: 'Web search', web_extract: 'Read a web page',
  database_query: 'Your own data', metrics: 'Your own KPIs',
  stripe: 'Stripe', razorpay: 'Razorpay', re: 'Real estate',
};
const toolLabel = (slug: string): string => {
  const known = TOOL_LABELS[String(slug).toLowerCase()];
  if (known) return known;
  const w = String(slug).replace(/[-_]+/g, ' ').trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

const ACTION_LABELS: Record<string, string> = {
  reply_sent: 'Replied to a customer',
  followup_sent: 'Followed up on a quiet lead',
  tool_executed: 'Ran a tool',
};
const actionLabel = (kind: string): string => ACTION_LABELS[kind] || kind.replace(/_/g, ' ');

const when = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
};

export default function EmployeeDetailPage() {
  const params = useParams();
  const id = String(params?.id || '');
  const [data, setData] = useState<EmployeeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/employees/${id}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body;
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return <div className="max-w-5xl mx-auto p-8 text-sm text-slate-500">Loading…</div>;
  }
  if (error || !data) {
    return (
      <div className="max-w-5xl mx-auto p-8 space-y-4">
        <Link href="/employees" className="text-sm text-slate-500 inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back to roster
        </Link>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error || 'Employee not found.'}
        </div>
      </div>
    );
  }

  const s = data.conversationStats;
  const totalActions = data.actionsByKind.reduce((sum, a) => sum + a.n, 0);
  const isActive = data.status === 'active';

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-20">
      <Link href="/employees" className="text-sm text-slate-500 inline-flex items-center gap-1 hover:text-slate-700">
        <ArrowLeft className="w-4 h-4" /> Back to roster
      </Link>

      {/* Identity */}
      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl font-serif font-bold text-heading">{data.name}</h1>
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider ${
            isActive ? 'bg-emerald-500/10 text-emerald-800 border border-emerald-500/30'
                     : 'bg-slate-500/10 text-slate-600 border border-slate-400/30'}`}>
            {data.status}
          </span>
        </div>
        <p className="text-sm text-slate-500">{data.role}</p>
        <p className="text-sm text-slate-600 max-w-2xl leading-relaxed">
          {data.persona || 'No instructions written yet. This employee will not act until someone gives it a persona.'}
        </p>
      </div>

      {/* Counters — every one of these is a row count */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Actions taken', value: totalActions, sub: 'every one attributed to this employee' },
          { label: 'Conversations', value: s.total, sub: 'threads it owns' },
          { label: 'Resolved', value: s.resolved, sub: 'closed without a person' },
          { label: 'Needs a person', value: s.needs_attention, sub: 'handed over' },
        ].map((c) => (
          <div key={c.label} className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-1 shadow-sm">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{c.label}</span>
            <div className="text-3xl font-bold text-heading">{c.value}</div>
            <span className="text-xs text-slate-500">{c.sub}</span>
          </div>
        ))}
      </div>

      {/* Permissions */}
      <section className="bg-white border border-cream-300 rounded-2xl p-6 space-y-3">
        <h2 className="font-serif font-bold text-heading flex items-center gap-2">
          <Shield className="w-4 h-4 text-slate-400" /> What it is allowed to touch
        </h2>
        {data.tools.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {data.tools.map((t) => (
              <span key={t} className="text-[11px] font-medium px-2 py-0.5 bg-cream-200 text-slate-700 rounded-md border border-cream-300">
                {toolLabel(t)}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400 italic">No tools assigned. It cannot act on anything outside this workspace.</p>
        )}
        <p className="text-xs text-slate-500">
          Anything not listed here is refused before it runs, not after.
        </p>
      </section>

      {/* What it did, by kind */}
      <section className="bg-white border border-cream-300 rounded-2xl p-6 space-y-3">
        <h2 className="font-serif font-bold text-heading flex items-center gap-2">
          <Activity className="w-4 h-4 text-slate-400" /> What it did
        </h2>
        {data.actionsByKind.length > 0 ? (
          <div className="divide-y divide-cream-300">
            {data.actionsByKind.map((a) => (
              <div key={a.action_kind} className="flex items-baseline justify-between py-2 gap-4">
                <span className="text-sm text-slate-700">{actionLabel(a.action_kind)}</span>
                <span className="text-xs text-slate-400 font-mono">last {when(a.last_at)}</span>
                <span className="text-sm font-bold text-heading tabular-nums">{a.n}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400 italic">
            Nothing recorded yet. This employee has not taken an action.
          </p>
        )}
      </section>

      {/* Recent actions with timestamps */}
      <section className="bg-white border border-cream-300 rounded-2xl p-6 space-y-3">
        <h2 className="font-serif font-bold text-heading flex items-center gap-2">
          <Clock className="w-4 h-4 text-slate-400" /> Most recent, with times
        </h2>
        {data.recentActions.length > 0 ? (
          <div className="divide-y divide-cream-300">
            {data.recentActions.map((a, i) => (
              <div key={`${a.source_table}-${a.source_id}-${i}`} className="py-2 flex items-baseline justify-between gap-4">
                <span className="text-sm text-slate-700">{actionLabel(a.action_kind)}</span>
                <span className="text-xs text-slate-400 font-mono shrink-0">{when(a.occurred_at)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400 italic">No actions recorded.</p>
        )}
      </section>

      {/* Conversations */}
      <section className="bg-white border border-cream-300 rounded-2xl p-6 space-y-3">
        <h2 className="font-serif font-bold text-heading flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-slate-400" /> Threads it owns
        </h2>
        {data.conversations.length > 0 ? (
          <div className="divide-y divide-cream-300">
            {data.conversations.map((c) => (
              <div key={c.id} className="py-2 flex items-baseline justify-between gap-4">
                <span className="text-sm text-slate-700 truncate">
                  {c.summary || c.contact_id || 'Conversation'}
                </span>
                <span className="text-[11px] uppercase tracking-wider text-slate-400 shrink-0">{c.status}</span>
                <span className="text-xs text-slate-400 font-mono shrink-0">{when(c.started_at)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400 italic">No conversations assigned to this employee.</p>
        )}
      </section>
    </div>
  );
}
