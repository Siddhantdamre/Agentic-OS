'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Calendar, Clock, MapPin, XCircle } from 'lucide-react';
import { ConfirmButton, LiveRegion, StatusBadge } from '@/components/a11y';
import { networkErrorMessage } from '@/lib/client-error';

interface ShowingRow {
  id: string;
  listingId?: string | null;
  inquiryId?: string | null;
  status?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  conflict?: boolean;
  calendarEventId?: string | null;
}

export default function ShowingsPage() {
  const [showings, setShowings] = useState<ShowingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/showings');
      if (!res.ok) {
        throw new Error(`Failed to load showings (HTTP ${res.status})`);
      }
      const data = (await res.json().catch(() => ({}))) as { showings?: ShowingRow[] };
      const rows = Array.isArray(data.showings) ? data.showings : [];
      setShowings(rows);
      setLiveMessage(
        rows.length === 0
          ? 'No showings in this workspace'
          : `${rows.length} showing${rows.length === 1 ? '' : 's'} loaded`
      );
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load showings');
      setShowings([]);
      setLiveMessage('Could not load showings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function cancelShowing(id: string) {
    if (!confirm('Cancel this showing? It will be removed from Google Calendar if connected.')) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/showings/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setLiveMessage('Showing cancelled');
        await load();
      } else {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setLiveMessage(data.error || 'Cancel failed');
      }
    } catch (err) {
      setLiveMessage(networkErrorMessage(err, 'We couldn’t cancel that showing. Please try again.'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-20 md:pb-8">
      <LiveRegion message={liveMessage} />
      <div>
        <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">Showings</h1>
        <p className="text-slate-500 text-sm mt-1">
          Upcoming property tours. Booking needs a connected Google Calendar, so a showing is never booked over a clash we cannot see.
        </p>
      </div>

      <div className="bg-white border border-cream-300 rounded-3xl divide-y divide-cream-200 shadow-sm">
        {loading ? (
          <p className="p-6 text-sm text-slate-500">Loading showings…</p>
        ) : loadError ? (
          <div className="p-10 text-center space-y-3">
            <AlertTriangle className="w-8 h-8 text-red-500 mx-auto" />
            <p className="font-medium text-red-900">Showings could not be loaded</p>
            <p className="text-xs text-red-700">{loadError}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-xl hover:bg-red-700 focus:outline-none"
            >
              Retry
            </button>
          </div>
        ) : showings.length === 0 ? (
          <div className="p-10 text-center">
            <Calendar className="w-8 h-8 text-slate-300 mx-auto mb-2" />
            <p className="font-medium text-heading">No showings yet</p>
            <p className="text-xs text-slate-500 mt-1">
              Book from{' '}
              <Link href="/listings" className="font-semibold text-amber-800 underline">
                Listings
              </Link>{' '}
              after connecting your calendar in Connectors.
            </p>
          </div>
        ) : (
          showings.map((s) => (
            <div key={s.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div className="p-2.5 bg-amber-50 rounded-xl text-amber-700 shrink-0">
                  <Calendar className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-heading truncate">
                    {s.listingId ? `Listing ${s.listingId.slice(0, 8)}…` : 'Property walkthrough'}
                  </p>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 mt-1">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      {s.startsAt ? new Date(s.startsAt).toLocaleString() : 'time TBD'}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="w-3.5 h-3.5" />
                      On-site
                    </span>
                    {s.conflict ? (
                      <span className="text-rose-600 font-medium">conflict flagged</span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge label={s.status || 'unknown'} tone="neutral" />
                {s.status !== 'cancelled' ? (
                  <ConfirmButton
                    disabled={busyId === s.id}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-rose-200 text-rose-700"
                    onClick={() => void cancelShowing(s.id)}
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    {busyId === s.id ? 'Cancelling…' : 'Cancel'}
                  </ConfirmButton>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
