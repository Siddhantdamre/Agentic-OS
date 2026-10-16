'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { ApprovalCard } from '@/components/approvals/ApprovalCard';
import { canApproveTogether, describeHeldAction, type ApprovalView, type HeldAction } from '@/lib/approval-view';
import { decideOne, notifyApprovalsChanged, type Outcome } from '@/lib/approvals-client';
import { networkErrorMessage, responseErrorMessage } from '@/lib/client-error';
import { useLiveRefresh } from '@/lib/use-live-refresh';

type Row = HeldAction & { status?: string; decidedAt?: string | null; executionError?: string | null };
type Item = { row: Row; view: ApprovalView };

const LIVE_EVENTS = ['settings_updated', 'work_item_updated', 'needs_attention'] as const;
const LOAD_FAILED = 'We couldn’t load your approvals just now. Please try again in a moment.';
const MESSAGE_KEYS = ['body', 'message', 'text'] as const;

function argsOf(row: Row): Record<string, unknown> {
  const p = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>).payload : null;
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

/** The argument that holds the message text, if it is plain text a person can fix before it goes out. */
function editableKey(row: Row): string | null {
  const args = argsOf(row);
  return MESSAGE_KEYS.find((k) => typeof args[k] === 'string' && (args[k] as string).trim()) ?? null;
}

/** Either the rows or one plain sentence for the person: nothing here throws, and no error text reaches the screen. */
async function fetchRows(url: string): Promise<{ rows: Row[] } | { error: string }> {
  try {
    const res = await fetch(url);
    if (!res.ok) return { error: await responseErrorMessage(res, LOAD_FAILED) };
    const data = (await res.json()) as { decisions?: Row[] };
    return { rows: Array.isArray(data.decisions) ? data.decisions : [] };
  } catch (err) {
    return { error: networkErrorMessage(err, LOAD_FAILED) };
  }
}

const DONE_LABEL: Record<string, (kind: string) => string> = {
  executed: (kind) => (kind === 'email' || kind === 'message' ? 'Sent' : 'Done'),
  rejected: () => 'Rejected',
  execution_failed: () => 'Did not run',
  expired: () => 'Expired',
  approved: () => 'Approved',
};

export default function ApprovalsPage() {
  const [tab, setTab] = useState<'waiting' | 'done'>('waiting');
  const [waiting, setWaiting] = useState<Item[] | null>(null);
  const [done, setDone] = useState<Item[] | null>(null);
  const [error, setError] = useState('');
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const itemsRef = useRef<Item[]>([]);

  const toItems = (rows: Row[], oldestFirst: boolean): Item[] => {
    const now = Date.now();
    const items = rows.map((row) => ({ row, view: describeHeldAction(row, now) }));
    return oldestFirst ? items.sort((a, b) => Date.parse(a.row.createdAt || '') - Date.parse(b.row.createdAt || '') || 0) : items;
  };

  const loadWaiting = useCallback(async () => {
    const result = await fetchRows('/api/decisions');
    if ('error' in result) return setError(result.error);
    setError('');
    setWaiting(toItems(result.rows, true));
  }, []);

  const loadDone = useCallback(async () => {
    const result = await fetchRows('/api/decisions?history=1');
    if ('error' in result) return setError(result.error);
    setError('');
    setDone(toItems(result.rows, false));
  }, []);

  useEffect(() => { void loadWaiting(); }, [loadWaiting]);
  useEffect(() => { if (tab === 'done' && done === null) void loadDone(); }, [tab, done, loadDone]);
  useLiveRefresh({ events: LIVE_EVENTS, refetch: loadWaiting, fallbackMs: 20000 });

  const items = waiting ?? [];
  itemsRef.current = items;
  const open = items.filter((i) => !outcomes[i.view.id]);
  const safe = open.filter((i) => canApproveTogether(i.view));
  const effectiveFocus = focusId && items.some((i) => i.view.id === focusId) ? focusId : items[0]?.view.id ?? null;

  const decide = useCallback(async (view: ApprovalView, decision: 'approved' | 'rejected', editedBody?: string) => {
    const item = itemsRef.current.find((i) => i.view.id === view.id);
    if (!item) return;
    const key = editedBody !== undefined ? editableKey(item.row) : null;
    setBusy((b) => new Set(b).add(view.id));
    const outcome = await decideOne({
      id: view.id,
      decision,
      kind: view.kind,
      ...(key && editedBody !== undefined ? { modifiedPayload: { ...argsOf(item.row), [key]: editedBody } } : {}),
    });
    setBusy((b) => { const next = new Set(b); next.delete(view.id); return next; });
    setOutcomes((o) => ({ ...o, [view.id]: outcome }));
    setSelected((s) => { const next = new Set(s); next.delete(view.id); return next; });
  }, []);

  const decideSelected = async (decision: 'approved' | 'rejected') => {
    const chosen = open.filter((i) => selected.has(i.view.id) && canApproveTogether(i.view));
    for (const item of chosen) {
      // One at a time: each is its own decision with its own record, and a failure stops nothing else.
      // eslint-disable-next-line no-await-in-loop
      await decide(item.view, decision);
    }
    notifyApprovalsChanged();
  };

  // Keyboard: J / K move, A approves, R rejects, X selects. Never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      const list = itemsRef.current;
      if (!list.length) return;
      const at = Math.max(0, list.findIndex((i) => i.view.id === (focusId ?? list[0].view.id)));
      const key = e.key.toLowerCase();
      if (key === 'j' || key === 'arrowdown') { setFocusId(list[Math.min(list.length - 1, at + 1)].view.id); e.preventDefault(); return; }
      if (key === 'k' || key === 'arrowup') { setFocusId(list[Math.max(0, at - 1)].view.id); e.preventDefault(); return; }
      const current = list[at];
      if (!current || outcomes[current.view.id] || busy.has(current.view.id)) return;
      if (key === 'a') void decide(current.view, 'approved');
      else if (key === 'r') void decide(current.view, 'rejected');
      else if (key === 'x' && canApproveTogether(current.view)) setSelected((s) => { const n = new Set(s); n.has(current.view.id) ? n.delete(current.view.id) : n.add(current.view.id); return n; });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [focusId, outcomes, busy, decide]);

  const waitingCount = open.length;
  const selectedCount = open.filter((i) => selected.has(i.view.id)).length;
  const allSafeSelected = safe.length > 0 && safe.every((i) => selected.has(i.view.id));

  const title = useMemo(() => (waiting === null ? 'Approvals' : 'Approvals'), [waiting]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-serif text-3xl font-bold text-heading">{title}</h1>
        <p className="text-sm text-slate-600">Your AI employees check with you here before anything important goes out.</p>
      </header>

      <div role="tablist" aria-label="Approvals" className="flex gap-2 border-b border-cream-300">
        {([['waiting', `Waiting${waiting ? ` (${waitingCount})` : ''}`], ['done', 'Done']] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 ${tab === id ? 'border-amber-500 text-heading' : 'border-transparent text-slate-500'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p> : null}

      {tab === 'waiting' ? (
        <section aria-live="polite" className="space-y-4">
          {waiting === null && !error ? <p className="text-sm text-slate-500">Loading…</p> : null}

          {waiting !== null && items.length === 0 && !error ? (
            <div className="rounded-2xl border border-dashed border-cream-300 bg-white p-8 text-center space-y-2">
              <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-700" aria-hidden="true" />
              <p className="font-serif text-lg text-heading">Nothing is waiting for you.</p>
              <p className="text-sm text-slate-600">When an AI employee wants to send a message, move money or change something, it asks here first.</p>
              <p className="text-sm text-slate-600">
                <Link href="/ask-ai" className="font-semibold text-heading underline">Ask an employee to do something</Link>
                {' · '}
                <Link href="/trust" className="font-semibold text-heading underline">See how much they can do alone</Link>
              </p>
            </div>
          ) : null}

          {items.length > 0 ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-serif text-xl text-heading">{waitingCount} waiting for you</h2>
                {safe.length >= 2 && !allSafeSelected ? (
                  <button type="button" onClick={() => setSelected(new Set(safe.map((i) => i.view.id)))} className="text-xs font-semibold text-heading underline">
                    {`Select all ${safe.length} that are safe to approve together`}
                  </button>
                ) : null}
                <span className="ml-auto text-xs text-slate-500">Keys: J / K move · A approve · R reject · X select</span>
              </div>

              {selectedCount > 0 ? (
                <div className="sticky top-2 z-10 flex flex-wrap items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 shadow-sm">
                  <span className="text-sm font-semibold text-heading">{selectedCount} selected</span>
                  <button type="button" onClick={() => void decideSelected('approved')} className="rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-heading">Approve selected</button>
                  <button type="button" onClick={() => void decideSelected('rejected')} className="rounded-xl bg-cream-200 px-4 py-2 text-xs font-bold text-heading">Reject selected</button>
                  <button type="button" onClick={() => setSelected(new Set())} className="text-xs font-semibold text-slate-600 underline">Clear</button>
                </div>
              ) : null}

              {items.map((item) => (
                <ApprovalCard
                  key={item.view.id}
                  view={item.view}
                  focused={effectiveFocus === item.view.id}
                  selectable={canApproveTogether(item.view)}
                  selected={selected.has(item.view.id)}
                  outcome={outcomes[item.view.id] ?? null}
                  busy={busy.has(item.view.id)}
                  editableKey={editableKey(item.row)}
                  onSelect={(id, on) => setSelected((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; })}
                  onDecide={decide}
                  onFocus={setFocusId}
                />
              ))}
            </>
          ) : null}
        </section>
      ) : (
        <section className="space-y-3">
          {done === null && !error ? <p className="text-sm text-slate-500">Loading…</p> : null}
          {done !== null && done.length === 0 && !error ? <p className="text-sm text-slate-600">Nothing has been decided yet.</p> : null}
          {(done ?? []).map(({ row, view }) => (
            <article key={view.id} className="rounded-2xl border border-cream-300 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="rounded-full bg-cream-100 px-2 py-0.5 font-semibold text-heading">
                  {(DONE_LABEL[row.status || ''] ?? (() => 'Closed'))(view.kind)}
                </span>
                <span className="font-semibold text-heading">{view.who}</span>
                <span aria-hidden="true">·</span>
                <span>{view.ageText}</span>
              </div>
              <h3 className="mt-1 font-serif text-base text-heading">{view.title}</h3>
              {row.status === 'execution_failed' && row.executionError ? <p className="mt-1 text-sm text-red-800">{row.executionError}</p> : null}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
