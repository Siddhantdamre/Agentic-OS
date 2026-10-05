'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ChevronDown } from 'lucide-react';
import { networkErrorMessage } from '@/lib/client-error';

interface AuditEvent {
  id: string;
  kind: string;
  actorType: string;
  actorUserId: string | null;
  actorEmployeeId: string | null;
  tool: string | null;
  action: string | null;
  riskClass: string | null;
  resultStatus: string | null;
  langfuseTraceId: string | null;
  payloadPreview: string;
  createdAt: string;
}

export default function AuditLogPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [riskClass, setRiskClass] = useState('all');
  const [kind, setKind] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [langfuseBase, setLangfuseBase] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchEvents = useCallback(
    async (cursor?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: '25' });
        if (cursor) params.set('cursor', cursor);
        if (riskClass !== 'all') params.set('riskClass', riskClass);
        if (kind.trim()) params.set('kind', kind.trim());
        if (from) params.set('from', new Date(from).toISOString());
        if (to) params.set('to', new Date(to + 'T23:59:59.999').toISOString());

        const res = await fetch(`/api/audit-logs?${params.toString()}`);
        if (res.status === 401) {
          window.location.href = '/login';
          return;
        }
        if (res.status === 403) {
          setError('Auditor or admin role required to view audit logs.');
          setEvents([]);
          setNextCursor(null);
          return;
        }
        if (!res.ok) throw new Error('We couldn’t load audit logs. Please try again.');
        const data = await res.json();
        const batch = (data.events || []) as AuditEvent[];
        setEvents((prev) => (cursor ? [...prev, ...batch] : batch));
        setNextCursor(data.nextCursor || null);
        setLangfuseBase(data.langfuseBaseUrl || null);
      } catch (err: unknown) {
        setError(networkErrorMessage(err, 'Failed to load audit logs'));
      } finally {
        setLoading(false);
      }
    },
    [riskClass, kind, from, to]
  );

  useEffect(() => {
    fetchEvents(null);
  }, [fetchEvents]);

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading flex items-center gap-2">
            <ShieldCheck className="w-7 h-7 text-amber-600" aria-hidden="true" />
            Audit log
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            A record of what your AI employees did and what you approved. Long details are shortened and sensitive values are hidden.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-slate-600 flex items-center gap-2">
          Kind
          <input
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            placeholder="e.g. settings.update"
            className="px-3 py-1.5 bg-white border border-cream-300 rounded-xl text-xs text-heading w-40"
          />
        </label>
        <label className="text-xs text-slate-600 flex items-center gap-2">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="px-2 py-1.5 bg-white border border-cream-300 rounded-xl text-xs text-heading" />
        </label>
        <label className="text-xs text-slate-600 flex items-center gap-2">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="px-2 py-1.5 bg-white border border-cream-300 rounded-xl text-xs text-heading" />
        </label>
        <label className="text-xs text-slate-600 flex items-center gap-2">
          Risk
          <select
            value={riskClass}
            onChange={(e) => setRiskClass(e.target.value)}
            className="px-3 py-1.5 bg-white border border-cream-300 rounded-xl text-xs text-heading"
          >
            <option value="all">All</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>
      ) : null}

      <div className="bg-white border border-cream-300 rounded-3xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-cream-100 text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="p-3 font-semibold">Time</th>
                <th className="p-3 font-semibold">Kind</th>
                <th className="p-3 font-semibold">Actor</th>
                <th className="p-3 font-semibold">Action</th>
                <th className="p-3 font-semibold">Risk</th>
                <th className="p-3 font-semibold">Status</th>
                <th className="p-3 font-semibold text-right">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200 text-slate-700">
              {events.map((ev) => (
                <React.Fragment key={ev.id}>
                  <tr className="hover:bg-cream-50">
                    <td className="p-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                      {new Date(ev.createdAt).toLocaleString()}
                    </td>
                    <td className="p-3">{ev.kind}</td>
                    <td className="p-3 font-medium text-heading">
                      {ev.actorEmployeeId || ev.actorUserId || ev.actorType}
                    </td>
                    <td className="p-3 font-mono text-amber-800">
                      {ev.tool ? `${ev.tool}:${ev.action || ''}` : ev.action || '—'}
                    </td>
                    <td className="p-3 capitalize">{ev.riskClass || '—'}</td>
                    <td className="p-3">{ev.resultStatus || '—'}</td>
                    <td className="p-3 text-right">
                      <button
                        type="button"
                        onClick={() => setExpandedId(expandedId === ev.id ? null : ev.id)}
                        className="inline-flex items-center gap-1 text-slate-500 hover:text-heading"
                        aria-expanded={expandedId === ev.id}
                      >
                        Preview
                        <ChevronDown
                          className={`w-3.5 h-3.5 transition-transform ${
                            expandedId === ev.id ? 'rotate-180' : ''
                          }`}
                        />
                      </button>
                    </td>
                  </tr>
                  {expandedId === ev.id ? (
                    <tr>
                      <td colSpan={7} className="p-3 bg-cream-50">
                        <pre className="text-[10px] font-mono text-slate-600 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                          {ev.payloadPreview || '—'}
                        </pre>
                        {ev.langfuseTraceId ? (
                          <p className="mt-2 text-[11px] text-slate-500">
                            Trace:{' '}
                            {langfuseBase ? (
                              <a
                                href={`${langfuseBase}/trace/${encodeURIComponent(ev.langfuseTraceId)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-mono text-amber-800 underline"
                              >
                                {ev.langfuseTraceId}
                              </a>
                            ) : (
                              <span className="font-mono">{ev.langfuseTraceId}</span>
                            )}
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              ))}
              {!loading && events.length === 0 && !error ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-500">
                    No audit events yet for this org.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {nextCursor ? (
          <div className="p-4 border-t border-cream-200 text-center">
            <button
              type="button"
              disabled={loading}
              onClick={() => fetchEvents(nextCursor)}
              className="px-4 py-2 bg-cream-100 hover:bg-cream-200 text-heading rounded-xl text-xs font-medium disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Load older events'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
