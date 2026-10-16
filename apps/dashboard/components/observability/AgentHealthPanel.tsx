'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { StatusBadge, type StatusTone } from '@/components/a11y/StatusBadge';
import { useLiveRefresh } from '@/lib/use-live-refresh';

type Status = 'stuck' | 'watch' | 'ok' | 'new' | 'paused';

interface Row {
  id: string;
  name: string;
  role: string;
  status: Status;
  reasons: string[];
  lastActionAt: string | null;
  waiting: number;
}
interface Snapshot {
  employees: Row[];
  notes: Array<{ level: 'stuck' | 'watch'; text: string }>;
}

const LABEL: Record<Status, { text: string; tone: StatusTone }> = {
  stuck: { text: 'Needs attention', tone: 'danger' },
  watch: { text: 'Keep an eye on it', tone: 'warning' },
  ok: { text: 'Working well', tone: 'success' },
  new: { text: 'Just started', tone: 'info' },
  paused: { text: 'Paused', tone: 'neutral' },
};

const EVENTS = ['needs_attention', 'work_item_updated', 'plan_updated', 'settings_updated'] as const;
const LOAD_FAILED = 'The team overview isn’t available just now. Please try again in a moment.';

function since(iso: string | null, now: Date): string {
  if (!iso) return 'Has not acted yet';
  const hours = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return 'Last active just now';
  if (hours < 24) return `Last active ${Math.floor(hours)} hour${Math.floor(hours) === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `Last active ${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * One line per AI employee: is it alive, is work stuck behind a person, do its actions keep failing, do people keep
 * rewriting what it drafts. A failed load is said out loud; it is never shown as "all is well".
 */
export function AgentHealthPanel({ now }: { now?: Date }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    fetch('/api/observability/agents')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        // A reply that is not the snapshot we expect is a failure, never an empty team.
        if (!body || !Array.isArray(body.employees)) throw new Error('unexpected reply');
        setData({ employees: body.employees, notes: Array.isArray(body.notes) ? body.notes : [] });
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh({ events: EVENTS, refetch: load });

  const clock = now ?? new Date();

  return (
    <section aria-labelledby="agent-health-title" className="rounded-3xl border border-cream-300 bg-white p-6 shadow-sm space-y-4">
      <div>
        <h2 id="agent-health-title" className="font-serif text-xl text-heading">Your AI team, one by one</h2>
        <p className="text-sm text-slate-500 mt-1">Who is working, who is waiting on you, and who needs a look.</p>
      </div>
      {failed ? (
        <p role="alert" className="text-sm text-red-700">{LOAD_FAILED}</p>
      ) : !data ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          {data.notes.map((n) => (
            <p key={n.text} className={`text-sm rounded-xl border px-3 py-2 ${n.level === 'stuck' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
              {n.text}
            </p>
          ))}
          {data.employees.length === 0 ? (
            <p className="text-sm text-slate-600">No AI employees yet. They appear here once your team is set up.</p>
          ) : (
            <ul className="divide-y divide-cream-200">
              {data.employees.map((e) => (
                <li key={e.id} className="py-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium text-heading">
                      <span data-testid="agent-name">{e.name}</span>
                      <span className="ml-2 text-xs text-slate-500">{e.role}</span>
                    </p>
                    {e.reasons.map((r) => (
                      <p key={r} className="text-sm text-slate-700">{r}</p>
                    ))}
                    <p className="text-xs text-slate-500">
                      {since(e.lastActionAt, clock)}
                      {e.waiting > 0 ? ` · ${e.waiting} waiting` : ''}
                    </p>
                  </div>
                  <StatusBadge label={LABEL[e.status].text} tone={LABEL[e.status].tone} className="self-start shrink-0" />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
