'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { ConfirmButton } from '@/components/a11y';

interface ShowingResult {
  booked?: boolean;
  connected?: boolean;
  setupUrl?: string;
  showingId?: string;
  message?: string;
  error?: string;
}

interface ChargeRow {
  id: string;
  kind?: string;
  amount?: string | number | null;
  currency?: string;
  status?: string;
  dueAt?: string | null;
}

function defaultSlotLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(15, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIsoWithZone(local: string, _timeZone: string): { startIso: string; endIso: string; durationMinutes: number } | null {
  // datetime-local is wall clock without offset; interpret as the caller's IANA zone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) return null;
  const asUtcGuess = new Date(local);
  if (Number.isNaN(asUtcGuess.getTime())) return null;
  // `new Date(local)` uses the browser's local TZ — correct for client components.
  const startIso = asUtcGuess.toISOString();
  const durationMinutes = 60;
  const endIso = new Date(asUtcGuess.getTime() + durationMinutes * 60_000).toISOString();
  return { startIso, endIso, durationMinutes };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string | undefined): value is string {
  return Boolean(value && UUID_RE.test(value));
}

export function BookShowingControl(props: {
  listingId?: string;
  inquiryId?: string;
  showingId?: string;
  title?: string;
  onBooked?: () => void;
  onCancelled?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [startLocal, setStartLocal] = useState(defaultSlotLocal);
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [result, setResult] = useState<ShowingResult | null>(null);
  const timezone =
    typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' : 'UTC';

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const parsed = toIsoWithZone(startLocal, timezone);
    if (!parsed) return;
    const endTime = new Date(new Date(parsed.startIso).getTime() + durationMinutes * 60_000).toISOString();
    setPending(true);
    setResult(null);
    try {
      const res = await fetch('/api/showings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listingId: isUuid(props.listingId) ? props.listingId : undefined,
          inquiryId: isUuid(props.inquiryId) ? props.inquiryId : undefined,
          startTime: parsed.startIso,
          endTime,
          durationMinutes,
          timezone,
          summary: props.title ? `Showing: ${props.title}` : 'Property showing',
        }),
      });
      const data = (await res.json().catch(() => ({}))) as ShowingResult & {
        reconnectUrl?: string;
        conflict?: boolean;
      };
      setResult({
        ...data,
        setupUrl: data.setupUrl || data.reconnectUrl || '/connectors',
      });
      if (data.booked === true) props.onBooked?.();
    } catch {
      setResult({ booked: false, message: 'Could not reach the showing API.' });
    } finally {
      setPending(false);
    }
  }

  async function cancelShowing() {
    if (!isUuid(props.showingId)) {
      setOpen(false);
      return;
    }
    if (!confirm('Cancel this showing? It will be removed from Google Calendar if connected.')) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/showings/${props.showingId}`, { method: 'DELETE' });
      const data = (await res.json().catch(() => ({}))) as ShowingResult;
      if (res.ok) {
        setResult({ booked: false, message: data.message || 'Showing cancelled.' });
        props.onCancelled?.();
        setOpen(false);
      } else {
        setResult({ booked: false, error: data.error || 'Failed to cancel showing.' });
      }
    } catch {
      setResult({ booked: false, error: 'Could not reach the showing API.' });
    } finally {
      setCancelling(false);
    }
  }

  const notConnected = result && result.connected === false;

  return (
    <div className="space-y-2">
      {!open ? (
        <ConfirmButton
          className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-cream-100 hover:bg-amber-500/10 border border-cream-300 hover:border-amber-500/40 text-slate-700"
          onClick={() => setOpen(true)}
        >
          Book showing
        </ConfirmButton>
      ) : (
        <form onSubmit={onSubmit} className="space-y-2">
          <label className="block text-[11px] text-slate-500">
            Start ({timezone})
            <input
              type="datetime-local"
              required
              value={startLocal}
              onChange={(e) => setStartLocal(e.target.value)}
              className="mt-1 w-full text-xs border border-cream-300 rounded-lg px-2 py-1 bg-white text-heading"
            />
          </label>
          <label className="block text-[11px] text-slate-500">
            Duration (minutes)
            <input
              type="number"
              min={15}
              max={480}
              step={15}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Math.max(15, Number(e.target.value) || 60))}
              className="mt-1 w-full text-xs border border-cream-300 rounded-lg px-2 py-1 bg-white text-heading"
            />
          </label>
          <div className="flex gap-2 flex-wrap">
            <ConfirmButton
              type="submit"
              disabled={pending}
              className="px-2.5 py-1 text-[11px] font-bold rounded-lg bg-amber-500 hover:bg-amber-600 text-heading"
            >
              {pending ? 'Booking…' : 'Confirm slot'}
            </ConfirmButton>
            {isUuid(props.showingId) ? (
              <ConfirmButton
                type="button"
                disabled={cancelling}
                className="px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-rose-300 text-rose-700"
                onClick={() => void cancelShowing()}
              >
                {cancelling ? 'Cancelling…' : 'Cancel showing'}
              </ConfirmButton>
            ) : (
              <ConfirmButton
                type="button"
                className="px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-cream-300 text-slate-600"
                onClick={() => setOpen(false)}
              >
                Close
              </ConfirmButton>
            )}
          </div>
        </form>
      )}
      {result ? (
        <p className="text-[11px] text-slate-600" role="status">
          {result.error || result.message || (result.booked ? 'Showing booked.' : 'Showing was not booked.')}
          {notConnected ? (
            <>
              {' '}
              <Link href={result.setupUrl || '/connectors'} className="font-semibold text-amber-800 underline">
                /connectors
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export function RentChargesPanel() {
  const [charges, setCharges] = useState<ChargeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  async function load() {
    try {
      const res = await fetch('/api/rent-reminders');
      if (!res.ok) {
        setCharges([]);
        return;
      }
      const payload = (await res.json()) as { charges?: ChargeRow[] };
      setCharges(Array.isArray(payload.charges) ? payload.charges : []);
    } catch {
      setCharges([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function remind(chargeId: string) {
    setBusyId(chargeId);
    setMessage('');
    try {
      const res = await fetch('/api/rent-reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chargeId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
        closed?: boolean;
      };
      setMessage(
        data.error ||
          data.message ||
          (data.closed ? 'Unexpected close — charge should stay open without a PSP webhook.' : 'Reminder recorded.')
      );
      await load();
    } catch {
      setMessage('Could not reach the rent-reminder API.');
    } finally {
      setBusyId(null);
    }
  }

  const openCharges = charges.filter((c) => c.status === 'open');

  return (
    <section className="bg-white border border-cream-300 rounded-3xl p-4 space-y-3 shadow-sm">
      <div>
        <h2 className="text-sm font-semibold text-heading">Rent reminders</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Schedule from SoR charges only. Tenant “I paid” does not close a charge.
        </p>
      </div>
      {message ? (
        <p className="text-[11px] text-slate-600" role="status">
          {message}
        </p>
      ) : null}
      {loading ? (
        <p className="text-xs text-slate-500">Loading charges…</p>
      ) : openCharges.length === 0 ? (
        <p className="text-xs text-slate-500">
          No open rent charges in this workspace. Import from the lease sheet — Darex will not invent amounts.
        </p>
      ) : (
        <ul className="space-y-2">
          {openCharges.map((charge) => (
            <li
              key={charge.id}
              className="flex flex-wrap items-center justify-between gap-2 border border-cream-200 rounded-xl px-3 py-2"
            >
              <div className="text-xs text-slate-600">
                <span className="font-medium text-heading">{charge.kind || 'rent'}</span>
                {' · '}
                {charge.amount == null || charge.amount === ''
                  ? 'amount unknown in source'
                  : `${charge.amount} ${charge.currency || ''}`.trim()}
                {charge.dueAt ? ` · due ${new Date(charge.dueAt).toLocaleDateString()}` : null}
              </div>
              <ConfirmButton
                disabled={busyId === charge.id}
                className="px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-cream-100 hover:bg-amber-500/10 border border-cream-300 text-slate-700"
                onClick={() => void remind(charge.id)}
              >
                {busyId === charge.id ? 'Scheduling…' : 'Schedule reminder'}
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
