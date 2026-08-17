'use client';

import React, { useEffect, useState } from 'react';
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

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
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

export default function ListingsPage() {
  const [rows, setRows] = useState<ListingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [packReady, setPackReady] = useState<boolean | null>(null);
  const [liveMessage, setLiveMessage] = useState('');
  const [bhk, setBhk] = useState('');
  const [locality, setLocality] = useState('');
  const [maxPrice, setMaxPrice] = useState('');

  const loadListings = async (filters: { bhk: string; locality: string; maxPrice: string }) => {
    const params = new URLSearchParams();
    if (filters.bhk) params.set('bhk', filters.bhk);
    if (filters.locality) params.set('locality', filters.locality);
    if (filters.maxPrice) params.set('maxPrice', filters.maxPrice);
    const qs = params.toString();
    const [listingsA, listingsB] = await Promise.all([
      fetchJson(`/api/listings${qs ? `?${qs}` : ''}`),
      qs ? Promise.resolve(null) : fetchJson('/api/packs/listings'),
    ]);
    const fromA = rowsFromPayload(listingsA);
    const fromB = rowsFromPayload(listingsB);
    return fromA.length > 0 || qs ? fromA : fromB;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [fromApi, packs, onboarding] = await Promise.all([
        loadListings({ bhk: '', locality: '', maxPrice: '' }),
        fetchJson('/api/packs'),
        fetchJson('/api/org/onboarding'),
      ]);
      if (cancelled) return;
      setRows(fromApi);

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
        fromApi.length === 0
          ? 'No listings in this workspace'
          : `${fromApi.length} listing${fromApi.length === 1 ? '' : 's'} loaded`
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-20 md:pb-8">
      <LiveRegion message={liveMessage} />
      <div>
        <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading">Listings</h1>
        <p className="text-slate-500 text-sm mt-1">
          Inventory from the real-estate pack. Empty means no rows — nothing is invented.
        </p>
      </div>

      <form
        className="bg-white border border-cream-300 rounded-2xl p-4 flex flex-wrap gap-3 items-end"
        onSubmit={async (event) => {
          event.preventDefault();
          setLoading(true);
          const fromApi = await loadListings({ bhk, locality, maxPrice });
          setRows(fromApi);
          setLiveMessage(
            fromApi.length === 0
              ? 'No matching listings — will not invent inventory'
              : `${fromApi.length} listing${fromApi.length === 1 ? '' : 's'} matched`
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
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                    Loading listings…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
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
