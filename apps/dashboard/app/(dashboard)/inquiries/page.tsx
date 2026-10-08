'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useLiveRefresh } from '@/lib/use-live-refresh';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Inbox } from 'lucide-react';
import { LiveRegion, StatusBadge, type StatusTone } from '@/components/a11y';
import { isRealEstateBrokerage } from '@/app/(onboarding)/pack-recommendations';
import { BookShowingControl, RentChargesPanel } from '@/components/re/SchedulePanel';
import { networkErrorMessage } from '@/lib/client-error';

type InquiryStatus = 'new' | 'contacted' | 'showing' | 'closed' | 'lost' | string;

interface InquiryRow {
  id: string;
  contact?: string;
  channel?: string;
  status: InquiryStatus;
  listingRef?: string | null;
  updatedAt?: string;
  sla_deadline_at?: string | null;
  sla_breached?: boolean;
  matched_listing_ids?: string[];
}

const COLUMNS: Array<{ id: InquiryStatus; label: string; tone: StatusTone; next?: InquiryStatus }> = [
  { id: 'new', label: 'New', tone: 'warning', next: 'contacted' },
  { id: 'contacted', label: 'Contacted', tone: 'info', next: 'showing' },
  { id: 'showing', label: 'Showing', tone: 'pending', next: 'closed' },
  { id: 'closed', label: 'Closed', tone: 'success' },
];

type FetchResult = { ok: true; data: unknown } | { ok: false; status: number };

async function fetchJson(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, status: 0 };
  }
}

function rowsFromPayload(payload: unknown): InquiryRow[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  const raw = obj.inquiries ?? obj.items ?? obj.rows;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): InquiryRow | null => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id : '';
      if (!id) return null;
      const type = String(row.type || row.work_item_type || '');
      if (type && type !== 're.inquiry' && type !== 'inquiry') return null;
      return {
        id,
        contact: typeof row.contact === 'string' ? row.contact : typeof row.contact_id === 'string' ? row.contact_id : undefined,
        channel: typeof row.channel === 'string' ? row.channel : undefined,
        status: typeof row.status === 'string' ? row.status : 'new',
        listingRef: typeof row.listingRef === 'string' ? row.listingRef : null,
        updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : typeof row.updated_at === 'string' ? row.updated_at : undefined,
        sla_deadline_at:
          typeof row.sla_deadline_at === 'string'
            ? row.sla_deadline_at
            : null,
        sla_breached: row.sla_breached === true,
        matched_listing_ids: Array.isArray(row.matched_listing_ids)
          ? (row.matched_listing_ids as string[])
          : undefined,
      };
    })
    .filter((r): r is InquiryRow => r != null);
}

const INQUIRY_EVENTS = ['inquiry_updated', 'inquiry_deleted'] as const;

export default function InquiriesPage() {
  const [rows, setRows] = useState<InquiryRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [packReady, setPackReady] = useState<boolean | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const [movingId, setMovingId] = useState<string | null>(null);

  // True once "load more" appended pages; a live refresh would drop them.
  const pagedRef = useRef(false);

  const loadInquiries = async (opts?: {
    cursor?: string | null;
    append?: boolean;
    quiet?: boolean;
  }) => {
    if (!opts?.quiet) {
      if (opts?.append) setLoadingMore(true);
      else setLoading(true);
      setLoadError(null);
    }
    const url = opts?.cursor
      ? `/api/inquiries?cursor=${encodeURIComponent(opts.cursor)}`
      : '/api/inquiries';
    const inq = await fetchJson(url);
    if (!inq.ok) {
      if (opts?.quiet) {
        console.error('[inquiries] live refresh failed', inq.status);
        return;
      }
      setLoadError(inq.status ? `Could not load inquiries (HTTP ${inq.status}).` : 'Could not load inquiries.');
      if (!opts?.append) setRows([]);
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    const mapped = rowsFromPayload(inq.data);
    const cursor =
      inq.data && typeof inq.data === 'object' && typeof (inq.data as { nextCursor?: unknown }).nextCursor === 'string'
        ? (inq.data as { nextCursor: string }).nextCursor
        : null;
    pagedRef.current = Boolean(opts?.append);
    setNextCursor(cursor);
    setRows((prev) => (opts?.append ? [...prev, ...mapped] : mapped));
    if (!opts?.append && !opts?.quiet) {
      setLiveMessage(mapped.length === 0 ? 'No inquiries' : `${mapped.length} inquiries loaded`);
    }
    setLoading(false);
    setLoadingMore(false);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [onboarding, packs] = await Promise.all([
        fetchJson('/api/org/onboarding'),
        fetchJson('/api/packs'),
      ]);
      if (cancelled) return;
      await loadInquiries();

      const onboardingData = onboarding.ok ? onboarding.data : null;
      const onboardingType =
        onboardingData && typeof onboardingData === 'object'
          ? String((onboardingData as { businessType?: string }).businessType || '')
          : '';
      const packsData = packs.ok ? packs.data : null;
      const packObj = packsData && typeof packsData === 'object' ? (packsData as Record<string, unknown>) : {};
      const installed = Array.isArray(packObj.installed) ? packObj.installed : [];
      const packIds = installed.map((p) =>
        typeof p === 'string' ? p : typeof (p as { id?: string }).id === 'string' ? (p as { id: string }).id : ''
      );
      setPackReady(packIds.includes('real-estate-brokerage') || isRealEstateBrokerage(onboardingType));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useLiveRefresh({
    events: INQUIRY_EVENTS,
    refetch: () => {
      if (pagedRef.current) return;
      return loadInquiries({ quiet: true });
    },
  });

  const byColumn = (id: string) =>
    rows.filter((r) => (id === 'closed' ? r.status === 'closed' || r.status === 'lost' : r.status === id));

  const advanceStatus = async (id: string, nextStatus: InquiryStatus) => {
    setMovingId(id);
    try {
      const res = await fetch(`/api/inquiries/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === 'string' ? data.error : 'Failed to update inquiry');
      }
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status: nextStatus } : r)));
      setLiveMessage(`Inquiry moved to ${nextStatus}`);
    } catch (err) {
      console.error('Inquiry status update failed:', err);
      setLiveMessage(networkErrorMessage(err, 'Status update failed'));
    } finally {
      setMovingId(null);
    }
  };

  const isSlaBreached = (item: InquiryRow) => {
    if (item.sla_breached) return true;
    if (!item.sla_deadline_at || item.status !== 'new') return false;
    return new Date(item.sla_deadline_at).getTime() < Date.now();
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-20 md:pb-8">
      <LiveRegion message={liveMessage} />
      <div>
        <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">Inquiries</h1>
        <p className="text-sm text-slate-500 mt-1">
          Every customer enquiry, from new to closed. Nothing is made up: a column stays empty until a real enquiry lands in it.
        </p>
      </div>

      {packReady === false ? (
        <div className="bg-cream-50 border border-cream-300 rounded-2xl p-4 text-sm text-slate-600">
          The enquiry board turns on with the real-estate starter skills. Connect your channels in{' '}
          <Link href="/connectors" className="font-semibold text-amber-800 underline">
            Connectors
          </Link>{' '}
          to start receiving enquiries.
        </div>
      ) : null}

      {loading ? (
        <div className="p-8 text-center text-slate-500 font-serif">Loading inquiries…</div>
      ) : loadError ? (
        <div className="bg-red-50 border border-red-200 rounded-3xl p-10 text-center space-y-3">
          <AlertTriangle className="w-10 h-10 text-red-500 mx-auto" />
          <h2 className="font-serif font-bold text-red-900">Inquiries could not be loaded</h2>
          <p className="text-sm text-red-700">{loadError}</p>
          <button
            type="button"
            onClick={() => loadInquiries()}
            className="inline-flex items-center px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-xl hover:bg-red-700 focus:outline-none"
          >
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-dashed border-cream-300 rounded-3xl p-10 text-center space-y-2">
          <Inbox className="w-10 h-10 text-slate-300 mx-auto" />
          <h2 className="font-serif font-bold text-heading">No inquiries</h2>
          <p className="text-sm text-slate-500">No enquiries yet. They appear here when a customer writes in.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {COLUMNS.map((col) => {
              const items = byColumn(col.id);
              return (
                <section key={col.id} className="bg-cream-50 border border-cream-300 rounded-2xl p-3 min-h-[12rem]">
                  <div className="flex items-center justify-between mb-3">
                    <StatusBadge label={col.label} tone={col.tone} />
                    <span className="text-[11px] font-mono text-slate-500">{items.length}</span>
                  </div>
                  {items.length === 0 ? (
                    <p className="text-xs text-slate-400 px-1">Empty</p>
                  ) : (
                    <ul className="space-y-2">
                      {items.map((item) => (
                        <li key={item.id} className="bg-white border border-cream-300 rounded-xl p-3 text-xs space-y-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className="font-semibold text-heading">{item.contact || item.id}</p>
                            {isSlaBreached(item) ? (
                              <span className="inline-flex items-center gap-0.5 text-[10px] text-red-700 bg-red-50 px-1.5 py-0.5 rounded shrink-0">
                                <AlertTriangle className="w-3 h-3" /> SLA
                              </span>
                            ) : null}
                          </div>
                          <p className="text-slate-500">{item.channel || 'channel unknown'}</p>
                          {item.listingRef ? (
                            <p className="font-mono text-[10px] text-slate-400">{item.listingRef}</p>
                          ) : null}
                          {item.matched_listing_ids && item.matched_listing_ids.length > 0 ? (
                            <p className="text-[10px] text-slate-500">
                              {item.matched_listing_ids.length} matched listing(s)
                            </p>
                          ) : null}
                          {col.next ? (
                            <button
                              type="button"
                              disabled={movingId === item.id}
                              onClick={() => advanceStatus(item.id, col.next!)}
                              className="inline-flex items-center gap-0.5 text-[11px] font-medium text-amber-800 hover:underline disabled:opacity-50"
                            >
                              Advance <ArrowRight className="w-3 h-3" />
                            </button>
                          ) : null}
                          <BookShowingControl
                            inquiryId={item.id}
                            listingId={item.listingRef || undefined}
                            title={item.contact || item.id}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
          {nextCursor ? (
            <div className="flex justify-center">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadInquiries({ cursor: nextCursor, append: true })}
                className="text-xs font-medium px-4 py-2 rounded-lg border border-cream-300 bg-white text-heading disabled:opacity-50"
              >
                {loadingMore ? 'Loading…' : 'Load more inquiries'}
              </button>
            </div>
          ) : null}
        </>
      )}

      <RentChargesPanel />
    </div>
  );
}
