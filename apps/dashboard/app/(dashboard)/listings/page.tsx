'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useLiveRefresh } from '@/lib/use-live-refresh';
import Link from 'next/link';
import { Building2 } from 'lucide-react';
import { LiveRegion, StatusBadge } from '@/components/a11y';
import { isRealEstateBrokerage } from '@/app/(onboarding)/pack-recommendations';
import { BookShowingControl, RentChargesPanel } from '@/components/re/SchedulePanel';

interface ListingRow {
  id: string;
  title?: string;
  status?: string;
  price?: string | number | null;
  area?: string | null;
  source?: string | null;
  sourceRef?: string | null;
  bhk?: number | null;
}

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

function rowsFromPayload(payload: unknown): ListingRow[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  const raw = obj.listings ?? obj.rows ?? obj.items;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): ListingRow | null => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id : '';
      if (!id) return null;
      return {
        id,
        title: typeof row.title === 'string' ? row.title : typeof row.name === 'string' ? row.name : undefined,
        status: typeof row.status === 'string' ? row.status : undefined,
        price: (row.price ?? row.list_price ?? null) as string | number | null,
        area: typeof row.area === 'string' ? row.area : typeof row.locality === 'string' ? row.locality : null,
        source: typeof row.source === 'string' ? row.source : null,
        sourceRef: typeof row.sourceRef === 'string' ? row.sourceRef : typeof row.source_ref === 'string' ? row.source_ref : null,
        bhk: typeof row.bhk === 'number' ? row.bhk : null,
      };
    })
    .filter((r): r is ListingRow => r != null);
}

const LISTING_EVENTS = ['listing_updated'] as const;

type ListingFilters = { bhk: string; locality: string; maxPrice: string; currency: string };

export default function ListingsPage() {
  const [rows, setRows] = useState<ListingRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [packReady, setPackReady] = useState<boolean | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const [bhk, setBhk] = useState('');
  const [locality, setLocality] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    title: '',
    bhk: '2',
    list_price: '',
    currency: 'INR',
    locality: '',
    city: 'Mumbai',
    source_ref: '',
  });

  // Filters last applied (mount or submit), so a live refresh re-runs those, not the half-typed inputs.
  const appliedFilters = useRef<ListingFilters>({ bhk: '', locality: '', maxPrice: '', currency: 'INR' });

  const loadListings = async (filters: ListingFilters) => {
    const params = new URLSearchParams();
    if (filters.bhk) params.set('bhk', filters.bhk);
    if (filters.locality) params.set('locality', filters.locality);
    if (filters.maxPrice) params.set('maxPrice', filters.maxPrice);
    if (filters.currency) params.set('currency', filters.currency);
    params.set('limit', '50');
    const qs = params.toString();
    const [listingsA, listingsB] = await Promise.all([
      fetchJson(`/api/listings?${qs}`),
      filters.bhk || filters.locality || filters.maxPrice
        ? Promise.resolve({ ok: true as const, data: null })
        : fetchJson('/api/packs/listings'),
    ]);
    if (!listingsA.ok) {
      return {
        rows: [] as ListingRow[],
        error: listingsA.status
          ? `Could not load listings (HTTP ${listingsA.status}).`
          : 'Could not load listings.',
      };
    }
    const fromA = rowsFromPayload(listingsA.data);
    const fromB = listingsB.ok ? rowsFromPayload(listingsB.data) : [];
    const rows = fromA.length > 0 || filters.bhk || filters.locality || filters.maxPrice ? fromA : fromB;
    return { rows, error: null as string | null };
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [fromApi, packsRes, onboardingRes] = await Promise.all([
        loadListings({ bhk: '', locality: '', maxPrice: '', currency: 'INR' }),
        fetchJson('/api/packs'),
        fetchJson('/api/org/onboarding'),
      ]);
      if (cancelled) return;
      setRows(fromApi.rows);
      setLoadError(fromApi.error);

      const packs = packsRes.ok ? packsRes.data : null;
      const onboarding = onboardingRes.ok ? onboardingRes.data : null;
      const packObj = packs && typeof packs === 'object' ? (packs as Record<string, unknown>) : {};
      const installed = Array.isArray(packObj.installed)
        ? packObj.installed
        : Array.isArray(packObj.packs)
          ? packObj.packs
          : [];
      const packIds = installed.map((p) =>
        typeof p === 'string' ? p : typeof (p as { id?: string }).id === 'string' ? (p as { id: string }).id : ''
      );
      const onboardingType =
        onboarding && typeof onboarding === 'object'
          ? String((onboarding as { businessType?: string }).businessType || '')
          : '';
      const recommended = Array.isArray((onboarding as { recommendedPacks?: string[] } | null)?.recommendedPacks)
        ? ((onboarding as { recommendedPacks: string[] }).recommendedPacks)
        : [];
      const rePack =
        packIds.includes('real-estate-brokerage') ||
        recommended.includes('real-estate-brokerage') ||
        isRealEstateBrokerage(onboardingType);
      setPackReady(rePack);
      setLiveMessage(
        fromApi.error
          ? fromApi.error
          : fromApi.rows.length === 0
            ? 'No listings in this workspace'
            : `${fromApi.rows.length} listing${fromApi.rows.length === 1 ? '' : 's'} loaded`
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useLiveRefresh({
    events: LISTING_EVENTS,
    refetch: async () => {
      const fromApi = await loadListings(appliedFilters.current);
      // A failed background refresh keeps the last good rows on screen.
      if (fromApi.error) {
        console.error('[listings] live refresh failed:', fromApi.error);
        return;
      }
      setRows(fromApi.rows);
      setLoadError(null);
    },
  });

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-20 md:pb-8">
      <LiveRegion message={liveMessage} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">Listings</h1>
          <p className="text-slate-500 text-sm mt-1">
            Inventory from the real-estate pack. Empty means no rows — nothing is invented.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="px-3 py-2 text-xs font-bold rounded-lg bg-amber-500 hover:bg-amber-600 text-heading"
        >
          Add listing
        </button>
      </div>

      {addOpen ? (
        <form
          className="bg-white border border-cream-300 rounded-2xl p-4 space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setSaving(true);
            try {
              const res = await fetch('/api/listings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  title: form.title,
                  bhk: Number(form.bhk),
                  list_price: form.list_price,
                  currency: form.currency,
                  locality: form.locality,
                  city: form.city,
                  source: 'manual_entry',
                  source_ref: form.source_ref || `manual-${Date.now()}`,
                  status: 'active',
                }),
              });
              if (res.ok) {
                setAddOpen(false);
                setForm({ title: '', bhk: '2', list_price: '', currency: 'INR', locality: '', city: 'Mumbai', source_ref: '' });
                appliedFilters.current = { bhk, locality, maxPrice, currency };
                const fromApi = await loadListings(appliedFilters.current);
                setRows(fromApi.rows);
                setLoadError(fromApi.error);
                setLiveMessage(fromApi.error || 'Listing saved');
              } else {
                const data = (await res.json().catch(() => ({}))) as { error?: string };
                setLiveMessage(data.error || 'Failed to create listing');
              }
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-heading">Add property</h2>
            <button type="button" className="text-xs text-slate-500" onClick={() => setAddOpen(false)}>
              Close
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-xs text-slate-500 sm:col-span-2">
              Title
              <input
                required
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="mt-1 block w-full text-sm border border-cream-300 rounded-lg px-2 py-1.5"
              />
            </label>
            <label className="text-xs text-slate-500">
              BHK
              <input
                required
                type="number"
                min={1}
                value={form.bhk}
                onChange={(e) => setForm({ ...form, bhk: e.target.value })}
                className="mt-1 block w-full text-sm border border-cream-300 rounded-lg px-2 py-1.5"
              />
            </label>
            <label className="text-xs text-slate-500">
              Price
              <input
                required
                value={form.list_price}
                onChange={(e) => setForm({ ...form, list_price: e.target.value })}
                placeholder="12000000 or 1.2 Cr"
                className="mt-1 block w-full text-sm border border-cream-300 rounded-lg px-2 py-1.5"
              />
            </label>
            <label className="text-xs text-slate-500">
              Locality
              <input
                required
                value={form.locality}
                onChange={(e) => setForm({ ...form, locality: e.target.value })}
                className="mt-1 block w-full text-sm border border-cream-300 rounded-lg px-2 py-1.5"
              />
            </label>
            <label className="text-xs text-slate-500">
              City
              <input
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                className="mt-1 block w-full text-sm border border-cream-300 rounded-lg px-2 py-1.5"
              />
            </label>
            <label className="text-xs text-slate-500 sm:col-span-2">
              Source ref (required — will not invent)
              <input
                value={form.source_ref}
                onChange={(e) => setForm({ ...form, source_ref: e.target.value })}
                placeholder="optional — auto-generated if blank"
                className="mt-1 block w-full text-sm border border-cream-300 rounded-lg px-2 py-1.5"
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="px-3 py-2 text-xs font-bold rounded-lg bg-amber-500 hover:bg-amber-600 text-heading"
          >
            {saving ? 'Saving…' : 'Create listing'}
          </button>
        </form>
      ) : null}

      <form
        className="bg-white border border-cream-300 rounded-2xl p-4 flex flex-wrap gap-3 items-end"
        onSubmit={async (event) => {
          event.preventDefault();
          setLoading(true);
          appliedFilters.current = { bhk, locality, maxPrice, currency };
          const fromApi = await loadListings(appliedFilters.current);
          setRows(fromApi.rows);
          setLoadError(fromApi.error);
          setLiveMessage(
            fromApi.error
              ? fromApi.error
              : fromApi.rows.length === 0
                ? 'No matching listings — will not invent inventory'
                : `${fromApi.rows.length} listing${fromApi.rows.length === 1 ? '' : 's'} matched`
          );
          setLoading(false);
        }}
      >
        <label className="text-xs text-slate-500">
          BHK
          <input
            value={bhk}
            onChange={(e) => setBhk(e.target.value)}
            placeholder="2"
            inputMode="numeric"
            className="mt-1 block w-20 text-sm border border-cream-300 rounded-lg px-2 py-1.5 bg-white"
          />
        </label>
        <label className="text-xs text-slate-500">
          Locality
          <input
            value={locality}
            onChange={(e) => setLocality(e.target.value)}
            placeholder="Koramangala"
            className="mt-1 block w-44 text-sm border border-cream-300 rounded-lg px-2 py-1.5 bg-white"
          />
        </label>
        <label className="text-xs text-slate-500">
          Max price
          <input
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            placeholder="1.2 Cr"
            className="mt-1 block w-32 text-sm border border-cream-300 rounded-lg px-2 py-1.5 bg-white"
          />
        </label>
        <label className="text-xs text-slate-500">
          Currency
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="mt-1 block w-24 text-sm border border-cream-300 rounded-lg px-2 py-1.5 bg-white"
          >
            <option value="INR">INR</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
            <option value="AED">AED</option>
          </select>
        </label>
        <button
          type="submit"
          className="px-3 py-1.5 text-xs font-bold rounded-lg bg-amber-500 hover:bg-amber-600 text-heading focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          Filter sheet rows
        </button>
      </form>

      {packReady === false ? (
        <div className="bg-cream-50 border border-cream-300 rounded-2xl p-4 text-sm text-slate-600">
          This module is gated by the real-estate pack. Recommended connectors stay disconnected until you
          connect them on{' '}
          <Link href="/connectors" className="font-semibold text-amber-800 underline">
            /connectors
          </Link>
          .
        </div>
      ) : null}

      <div className="bg-white border border-cream-300 rounded-3xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm min-w-[36rem]">
            <caption className="sr-only">Listings inventory</caption>
            <thead className="bg-cream-100 text-[11px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">Title</th>
                <th className="px-4 py-3 font-semibold">Area</th>
                <th className="px-4 py-3 font-semibold">Price</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Source</th>
                <th className="px-4 py-3 font-semibold">Showing</th>
                <th className="px-4 py-3 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                    Loading listings…
                  </td>
                </tr>
              ) : loadError ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <p className="font-medium text-heading">Listings could not be loaded</p>
                    <p className="text-xs text-red-700 mt-1">{loadError}</p>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <Building2 className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                    <p className="font-medium text-heading">No listings</p>
                    <p className="text-xs text-slate-500 mt-1">
                      The sheet is empty. Connect Sheets or a licensed feed — Darex will not invent inventory.
                    </p>
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="border-t border-cream-200">
                    <td className="px-4 py-3 font-medium text-heading">{row.title || row.id}</td>
                    <td className="px-4 py-3 text-slate-600">{row.area || '—'}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {row.price == null || row.price === '' ? '—' : String(row.price)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge label={row.status || 'unknown'} tone="neutral" />
                    </td>
                    <td className="px-4 py-3 text-slate-500 font-mono text-xs">{row.sourceRef || row.source || '—'}</td>
                    <td className="px-4 py-3">
                      <BookShowingControl listingId={row.id} title={row.title || row.sourceRef || row.id} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <select
                          className="text-[11px] border border-cream-300 rounded-lg px-1.5 py-1 bg-white"
                          value={row.status || 'active'}
                          onChange={async (e) => {
                            const status = e.target.value;
                            const res = await fetch(`/api/listings/${row.id}`, {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ status }),
                            });
                            if (res.ok) {
                              setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status } : r)));
                              setLiveMessage(`Updated status to ${status}`);
                            } else {
                              setLiveMessage('Status update failed');
                            }
                          }}
                        >
                          <option value="active">active</option>
                          <option value="under_offer">under_offer</option>
                          <option value="reserved">reserved</option>
                          <option value="sold">sold</option>
                          <option value="rented">rented</option>
                          <option value="withdrawn">withdrawn</option>
                          <option value="stale">stale</option>
                          <option value="draft">draft</option>
                        </select>
                        <button
                          type="button"
                          className="text-[11px] text-rose-700 text-left"
                          onClick={async () => {
                            if (!confirm('Withdraw this listing?')) return;
                            const res = await fetch(`/api/listings/${row.id}`, { method: 'DELETE' });
                            if (res.ok) {
                              setRows((prev) => prev.filter((r) => r.id !== row.id));
                              setLiveMessage('Listing withdrawn');
                            }
                          }}
                        >
                          Withdraw
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <RentChargesPanel />
    </div>
  );
}
