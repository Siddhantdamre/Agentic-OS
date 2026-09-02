'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Radio, Wrench, CheckCircle2, AlertCircle } from 'lucide-react';

/**
 * Watch the AI employees work, as it happens.
 *
 * Every agent run was written to channel_logs and published nowhere. The SSE
 * bus existed, per-org and working, and the only screen subscribing to it was
 * the conversations list — so the honest answer to "what is my AI employee
 * doing right now" was to open the database.
 *
 * This is the answer to that question, and it is more than a convenience.
 * Nobody hands work to an agent they have never watched. Shadow mode lets an
 * owner read what the agent WOULD have said; this lets them see it working at
 * all, which is the step before that.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 * It shows nothing until an event arrives. No skeleton rows, no "simulating",
 * no sample activity while the stream is quiet. A live view that invents
 * activity to look busy is worse than an empty one, because the whole point is
 * that you are seeing the real thing.
 */

interface ActivityEvent {
  id: string;
  employeeName: string | null;
  selfDirected: boolean;
  succeeded: boolean;
  usedTools: string[];
  stepsCount: number;
  at: string;
}

const TOOL_LABELS: Record<string, string> = {
  database_query: 'read your data',
  metrics: 'checked KPIs',
  metrics_query: 'checked KPIs',
  web_extract: 'read a web page',
  web_search: 'searched the web',
  gmail: 'used Gmail',
  whatsapp: 'used WhatsApp',
  'google-calendar': 'used Calendar',
};

const prettyTool = (raw: string): string => {
  const t = String(raw).replace(/^mcp\.darex\./, '').toLowerCase();
  return TOOL_LABELS[t] || t.replace(/[-_]+/g, ' ');
};

const clock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

export function LiveActivity({ max = 12 }: { max?: number }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    // EventSource reconnects on its own; no retry loop of our own is needed,
    // and adding one would fight the browser's backoff.
    const src = new EventSource('/api/stream/events');

    src.addEventListener('connected', () => setConnected(true));
    src.onerror = () => setConnected(false);

    const onActivity = (raw: MessageEvent) => {
      try {
        const d = JSON.parse(raw.data) as Partial<ActivityEvent>;
        seq.current += 1;
        setEvents((prev) => [
          {
            id: `${Date.now()}-${seq.current}`,
            employeeName: d.employeeName ?? null,
            selfDirected: Boolean(d.selfDirected),
            succeeded: d.succeeded !== false,
            usedTools: Array.isArray(d.usedTools) ? d.usedTools : [],
            stepsCount: Number(d.stepsCount ?? 0),
            at: typeof d.at === 'string' ? d.at : new Date().toISOString(),
          },
          ...prev,
        ].slice(0, max));
      } catch {
        // A malformed frame drops that frame, never the stream.
      }
    };

    // The bus delivers named events; some deployments forward everything on
    // the default `message` channel, so listen to both and let the parse
    // decide. An event without an employee is not agent activity.
    src.addEventListener('agent.activity', onActivity as EventListener);
    src.addEventListener('message', (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data);
        if (d && (d.type === 'agent.activity' || d.employeeName)) onActivity(e as MessageEvent);
      } catch { /* ignore */ }
    });

    return () => src.close();
  }, [max]);

  return (
    <section className="bg-white border border-cream-300 rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-serif font-bold text-heading flex items-center gap-2">
            <Radio className={`w-4 h-4 ${connected ? 'text-emerald-600' : 'text-slate-300'}`} />
            Your employees, right now
          </h2>
          <p className="text-xs text-slate-500 mt-1">
            Every action an AI employee takes appears here as it happens.
          </p>
        </div>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border ${
          connected
            ? 'bg-emerald-500/10 text-emerald-800 border-emerald-500/30'
            : 'bg-slate-500/10 text-slate-500 border-slate-400/30'}`}>
          {connected ? 'LIVE' : 'NOT CONNECTED'}
        </span>
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-slate-500 leading-relaxed">
          {connected
            ? 'Nothing yet. This stays empty until an employee actually does something — it will not invent activity to look busy.'
            : 'Waiting for the activity stream.'}
        </p>
      ) : (
        <div className="divide-y divide-cream-300">
          {events.map((e) => (
            <div key={e.id} className="py-2.5 flex items-baseline gap-3">
              {e.succeeded
                ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 translate-y-0.5" />
                : <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0 translate-y-0.5" />}
              <div className="flex-1 min-w-0">
                <span className="text-sm text-slate-800 font-semibold">
                  {e.employeeName || 'An employee'}
                </span>
                <span className="text-sm text-slate-600">
                  {e.selfDirected ? ' ran its own duty' : ' handled a request'}
                  {e.succeeded ? '' : ' — and reported it could not finish'}
                </span>
                {e.usedTools.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <Wrench className="w-3 h-3 text-slate-400" />
                    {e.usedTools.slice(0, 4).map((t, i) => (
                      <span key={i} className="text-[11px] px-1.5 py-0.5 bg-cream-200 border border-cream-300 rounded text-slate-700">
                        {prettyTool(t)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <span className="text-xs text-slate-400 font-mono shrink-0">{clock(e.at)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
