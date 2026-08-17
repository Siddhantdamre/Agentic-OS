'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { LiveRegion, StatusBadge, type StatusTone } from '@/components/a11y';
import { isRealEstateBrokerage } from '@/app/(onboarding)/pack-recommendations';
import { BookShowingControl, RentChargesPanel } from '@/components/re/SchedulePanel';

type InquiryStatus = 'new' | 'contacted' | 'showing' | 'closed' | string;

interface InquiryRow {
  id: string;
  contact?: string;
  channel?: string;
  status: InquiryStatus;
  listingRef?: string | null;
  updatedAt?: string;
}

const COLUMNS: Array<{ id: InquiryStatus; label: string; tone: StatusTone }> = [
  { id: 'new', label: 'New', tone: 'warning' },
  { id: 'contacted', label: 'Contacted', tone: 'info' },
  { id: 'showing', label: 'Showing', tone: 'pending' },
  { id: 'closed', label: 'Closed', tone: 'success' },
];

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function rowsFromPayload(payload: unknown): InquiryRow[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  const raw = obj.inquiries ?? obj.workItems ?? obj.items ?? obj.rows;
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
      };
    })
    .filter((r): r is InquiryRow => r != null);
}

export default function InquiriesPage() {
  const [rows, setRows] = useState<InquiryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [packReady, setPackReady] = useState<boolean | null>(null);
  const [liveMessage, setLiveMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [inq, workItems, onboarding, packs] = await Promise.all([
        fetchJson('/api/inquiries'),
        fetchJson('/api/work-items?type=re.inquiry'),
        fetchJson('/api/org/onboarding'),
        fetchJson('/api/packs'),
      ]);
      if (cancelled) return;
      const merged = [...rowsFromPayload(inq), ...rowsFromPayload(workItems)];
      const seen = new Set<string>();
      const unique = merged.filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
      setRows(unique);

      const onboardingType =
        onboarding && typeof onboarding === 'object'
          ? String((onboarding as { businessType?: string }).businessType || '')
          : '';
      const packObj = packs && typeof packs === 'object' ? (packs as Record<string, unknown>) : {};
      const installed = Array.isArray(packObj.installed) ? packObj.installed : [];
      const packIds = installed.map((p) =>
        typeof p === 'string' ? p : typeof (p as { id?: string }).id === 'string' ? (p as { id: string }).id : ''
      );
      setPackReady(packIds.includes('real-estate-brokerage') || isRealEstateBrokerage(onboardingType));
      setLiveMessage(unique.length === 0 ? 'No inquiries' : `${unique.length} inquiries loaded`);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const byColumn = (id: string) => rows.filter((r) => r.status === id);

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-20 md:pb-8">
      <LiveRegion message={liveMessage} />
      <div>
        <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">Inquiries</h1>
        <p className="text-slate-500 text-sm mt-1">
          Kanban of real inquiry work items. Empty columns stay empty.
        </p>
      </div>

      {packReady === false ? (
        <div className="bg-cream-50 border border-cream-300 rounded-2xl p-4 text-sm text-slate-600">
          Inquiry board is part of the real-estate pack. Connect channels on{' '}
          <Link href="/connectors" className="font-semibold text-amber-800 underline">
            /connectors
          </Link>{' '}
          — recommended is not the same as connected.
        </div>
      ) : null}

      {loading ? (
        <div className="p-8 text-center text-slate-500 font-serif">Loading inquiries…</div>
      ) : rows.length === 0 ? (
        <div className="bg-white border border-dashed border-cream-300 rounded-3xl p-10 text-center space-y-2">
          <Inbox className="w-10 h-10 text-slate-300 mx-auto" />
          <h2 className="font-serif font-bold text-heading">No inquiries</h2>
          <p className="text-sm text-slate-500">There are no inquiry work items for this org yet.</p>
        </div>
      ) : (
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
                        <p className="font-semibold text-heading">{item.contact || item.id}</p>
                        <p className="text-slate-500">{item.channel || 'channel unknown'}</p>
                        {item.listingRef ? (
                          <p className="font-mono text-[10px] text-slate-400">{item.listingRef}</p>
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
      )}

      <RentChargesPanel />
    </div>
  );
}
