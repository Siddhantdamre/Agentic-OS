'use client';

import React, { useEffect, useState } from 'react';
import { Package, CheckCircle2, Sparkles, AlertCircle } from 'lucide-react';

type PackRow = {
  id: string;
  name: string;
  version: string;
  live: boolean;
  extends: string | null;
  markets: string[] | null;
  manifest: Record<string, unknown> | null;
};

type InstalledRow = {
  packId: string;
  status: string;
  primary: boolean;
};

type PacksPayload = {
  packs: PackRow[];
  installed: InstalledRow[];
  livePackIds?: string[];
  error?: string;
};

export default function PacksMarketplacePage() {
  const [data, setData] = useState<PacksPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/packs');
      const json = (await res.json()) as PacksPayload;
      setData(json);
      if (!res.ok) setMessage(json.error || 'Could not load packs');
    } catch {
      setMessage('Could not load packs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const installedStatus = (packId: string): string | null => {
    const row = data?.installed.find((i) => i.packId === packId && i.status === 'installed');
    return row?.status ?? null;
  };

  const install = async (packId: string) => {
    setBusyId(packId);
    setMessage(null);
    try {
      const res = await fetch('/api/packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error || 'Install failed');
        return;
      }
      await load();
    } catch {
      setMessage('Install failed');
    } finally {
      setBusyId(null);
    }
  };

  const uninstall = async (packId: string) => {
    setBusyId(packId);
    setMessage(null);
    try {
      const res = await fetch('/api/packs', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error || 'Uninstall failed');
        return;
      }
      await load();
    } catch {
      setMessage('Uninstall failed');
    } finally {
      setBusyId(null);
    }
  };

  const upgrade = async (packId: string) => {
    setBusyId(packId);
    setMessage(null);
    try {
      const res = await fetch('/api/packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId, action: 'upgrade' }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error || 'Upgrade failed');
        return;
      }
      setMessage(
        `Upgraded ${packId}: ${json.upgraded ?? 0} employees refreshed, ${json.seeded ?? 0} seeded.`
      );
      await load();
    } catch {
      setMessage('Upgrade failed');
    } finally {
      setBusyId(null);
    }
  };

  const configure = async (packId: string) => {
    const raw = window.prompt('Pack config JSON (merged into org_packs.config)', '{"notes":""}');
    if (raw == null) return;
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      setMessage('Config must be valid JSON');
      return;
    }
    setBusyId(packId);
    setMessage(null);
    try {
      const res = await fetch(`/api/packs/${encodeURIComponent(packId)}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMessage(json.error || 'Config update failed');
        return;
      }
      setMessage(`Config saved for ${packId}`);
      await load();
    } catch {
      setMessage('Config update failed');
    } finally {
      setBusyId(null);
    }
  };

  const liveIds = new Set(data?.livePackIds ?? ['core-b2b', 'real-estate-brokerage']);

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12">
      <div>
        <h1 className="text-3xl font-serif font-bold text-heading flex items-center gap-2">
          <Package className="w-7 h-7 text-amber-700" />
          Industry packs
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Pre-configured AI employees, connector recommendations, and SOPs. Connectors are never
          marked connected until OAuth succeeds.
        </p>
      </div>

      {message && (
        <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          {message}
        </div>
      )}

      {loading || !data ? (
        <div className="p-8 text-center text-slate-500 font-serif">Loading packs…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {(data.packs.length > 0 ? data.packs : [
            {
              id: 'core-b2b',
              name: 'Core B2B',
              version: '1.0.0',
              live: true,
              extends: null,
              markets: [],
              manifest: null,
            },
            {
              id: 'real-estate-brokerage',
              name: 'Real estate brokerage',
              version: '1.0.0',
              live: true,
              extends: 'core-b2b',
              markets: ['IN'],
              manifest: null,
            },
          ]).map((pack) => {
            const isLive = pack.live === true || liveIds.has(pack.id);
            const isInstalled = installedStatus(pack.id) === 'installed';
            return (
              <div
                key={pack.id}
                className={`p-6 rounded-3xl border shadow-sm ${
                  isInstalled
                    ? 'bg-white border-emerald-200'
                    : 'bg-white border-cream-300'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-lg font-serif font-bold text-heading">{pack.name}</h2>
                      {isInstalled ? (
                        <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
                          <CheckCircle2 className="w-3 h-3" /> Installed
                        </span>
                      ) : isLive ? (
                        <span className="text-xs font-bold text-amber-800 bg-amber-50 px-2 py-0.5 rounded-full">
                          Live
                        </span>
                      ) : (
                        <span className="text-xs font-bold text-slate-500 bg-cream-100 px-2 py-0.5 rounded-full">
                          Coming soon
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-slate-500 mt-2">
                      {pack.extends ? `Extends ${pack.extends}. ` : ''}
                      Version {pack.version || '1.0.0'}
                      {pack.markets && pack.markets.length > 0
                        ? ` · Markets: ${pack.markets.join(', ')}`
                        : ''}
                    </p>
                  </div>
                </div>
                <div className="mt-6 flex items-center justify-end gap-2 flex-wrap">
                  {isInstalled ? (
                    <>
                      <button
                        type="button"
                        disabled={busyId === pack.id}
                        onClick={() => void configure(pack.id)}
                        className="px-3 py-1.5 text-xs font-bold border border-cream-300 rounded-2xl disabled:opacity-50"
                      >
                        Configure
                      </button>
                      <button
                        type="button"
                        disabled={busyId === pack.id}
                        onClick={() => void upgrade(pack.id)}
                        className="px-3 py-1.5 text-xs font-bold border border-cream-300 rounded-2xl disabled:opacity-50"
                      >
                        Upgrade
                      </button>
                      <button
                        type="button"
                        disabled={busyId === pack.id}
                        onClick={() => void uninstall(pack.id)}
                        className="px-3 py-1.5 text-xs font-bold border border-cream-300 rounded-2xl disabled:opacity-50"
                      >
                        {busyId === pack.id ? 'Working…' : 'Uninstall'}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={!isLive || busyId === pack.id}
                      onClick={() => void install(pack.id)}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-bold bg-[#F0C05A] text-[#121917] rounded-2xl disabled:opacity-50"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      {busyId === pack.id ? 'Installing…' : 'Install'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
