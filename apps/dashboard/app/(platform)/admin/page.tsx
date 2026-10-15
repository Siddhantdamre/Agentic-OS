'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Search, Shield, RefreshCw } from 'lucide-react';
import { StatusBadge, type StatusTone } from '@/components/a11y';
import {
  fetchPlatformObservability,
  fetchPlatformOrgs,
  searchPlatformOrgs,
  isSupportOnly,
} from '@/components/platform';
import { PlatformHealthStrip } from '@/components/platform/PlatformHealthStrip';
import type {
  PlatformObservability,
  PlatformOrgRow,
  PlatformRole,
} from '@/components/platform/types';

function statusTone(status: string | null | undefined): StatusTone {
  switch ((status || '').toLowerCase()) {
    case 'active':
      return 'success';
    case 'past_due':
    case 'provisioning':
      return 'warning';
    case 'suspended':
    case 'soft_deleted':
      return 'danger';
    default:
      return 'neutral';
  }
}

function healthTone(health: string | null | undefined, alertCount?: number | null): StatusTone {
  if (health === 'unknown' || health == null) return 'neutral';
  if (health === 'alert' || (typeof alertCount === 'number' && alertCount > 0)) return 'danger';
  if (health === 'ok') return 'success';
  return 'neutral';
}

function healthLabel(row: PlatformOrgRow): string {
  // Prefer explicit health string from API. Never invent "ok" when unknown.
  if (row.health === 'unknown' || row.health == null || row.health === '') {
    return 'unknown';
  }
  if (row.health === 'alert') {
    return typeof row.healthAlertCount === 'number'
      ? `alert (${row.healthAlertCount})`
      : 'alert';
  }
  if (row.health === 'ok') {
    return typeof row.healthAlertCount === 'number' && row.healthAlertCount > 0
      ? `alert (${row.healthAlertCount})`
      : 'ok';
  }
  if (typeof row.healthAlertCount === 'number') {
    return row.healthAlertCount > 0 ? `alert (${row.healthAlertCount})` : 'ok';
  }
  return 'unknown';
}

function seatsLabel(row: PlatformOrgRow): string {
  const used = row.seatsUsed ?? null;
  const cap = row.seatCap ?? row.seats ?? null;
  if (used == null && cap == null) return '—';
  if (used != null && cap != null) return `${used}/${cap}`;
  if (used != null) return `${used}`;
  return `cap ${cap}`;
}

function formatActivity(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export default function PlatformAdminDirectoryPage() {
  const [orgs, setOrgs] = useState<PlatformOrgRow[]>([]);
  const [platformRole, setPlatformRole] = useState<PlatformRole | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [obs, setObs] = useState<PlatformObservability | null>(null);
  const [obsLoading, setObsLoading] = useState(true);
  const [obsError, setObsError] = useState<string | null>(null);

  const loadOrgs = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    setMigrationMissing(false);
    const result = await fetchPlatformOrgs();
    if (!result.ok) {
      setOrgs([]);
      setForbidden(result.error.forbidden || result.error.notFound);
      setMigrationMissing(result.error.migrationMissing);
      setError(
        result.error.forbidden || result.error.notFound
          ? 'Platform admin access required. This console is not available for your account.'
          : result.error.migrationMissing
            ? 'Platform tables are not available yet (migration not applied).'
            : result.error.message
      );
      setLoading(false);
      return;
    }
    setOrgs(result.data.orgs);
    if (result.platformRole) setPlatformRole(result.platformRole);
    setLoading(false);
  }, []);

  const loadObs = useCallback(async () => {
    setObsLoading(true);
    setObsError(null);
    const result = await fetchPlatformObservability();
    if (!result.ok) {
      setObs(null);
      setObsError(
        result.error.forbidden || result.error.notFound
          ? 'Observability unavailable for this session.'
          : result.error.migrationMissing
            ? 'Platform observability not ready (migration missing).'
            : result.error.message
      );
      setObsLoading(false);
      return;
    }
    setObs(result.data);
    if (result.platformRole) setPlatformRole(result.platformRole);
    setObsLoading(false);
  }, []);

  useEffect(() => {
    void loadOrgs();
    void loadObs();
  }, [loadOrgs, loadObs]);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) {
      void loadOrgs();
      return;
    }
    setSearching(true);
    setError(null);
    const result = await searchPlatformOrgs(q);
    setSearching(false);
    if (!result.ok) {
      setForbidden(result.error.forbidden || result.error.notFound);
      setError(result.error.message);
      return;
    }
    setOrgs(result.data.orgs);
    if (result.platformRole) setPlatformRole(result.platformRole);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading flex items-center gap-2">
            <Shield className="w-7 h-7 text-amber-700" aria-hidden="true" />
            Platform directory
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Cross-org operator console. Reads are audited. Mutations require confirmation.
            {platformRole ? (
              <span className="ml-1 font-semibold text-heading">Role: {platformRole}</span>
            ) : null}
            {isSupportOnly(platformRole) ? (
              <span className="ml-1 text-slate-500">(operator actions hidden)</span>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void loadOrgs();
            void loadObs();
          }}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold border border-cream-300 rounded-xl hover:bg-cream-100 text-heading"
        >
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
          Refresh
        </button>
      </div>

      <PlatformHealthStrip data={obs} loading={obsLoading} error={obsError} />

      <form onSubmit={runSearch} className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search email, org name/slug, or connector id"
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-cream-300 rounded-xl text-sm text-heading focus:outline-none focus:border-amber-500"
          />
        </div>
        <button
          type="submit"
          disabled={searching || loading}
          className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 text-heading text-xs font-bold rounded-xl disabled:opacity-50 shrink-0"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 space-y-2">
          <p>{error}</p>
          {forbidden ? (
            <p className="text-xs text-red-700">
              If you believe this is wrong, ask an operator to insert your row in{' '}
              <code className="font-mono">platform_admins</code>.
            </p>
          ) : null}
          {migrationMissing ? (
            <p className="text-xs text-red-700">
              Apply migration 119+ before this console can load org data.
            </p>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="p-8 text-center text-slate-500 font-serif">Loading organizations…</div>
      ) : !error && orgs.length === 0 ? (
        <div className="bg-white border border-cream-300 rounded-3xl p-8 text-center shadow-sm space-y-2">
          <h2 className="font-serif font-bold text-heading">No organizations</h2>
          <p className="text-sm text-slate-500">
            {query.trim()
              ? 'No orgs matched that search.'
              : 'The directory returned zero orgs. This is not placeholder data.'}
          </p>
        </div>
      ) : !error ? (
        <div className="bg-white border border-cream-300 rounded-3xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs min-w-[720px]">
              <thead className="bg-cream-100 text-slate-500 uppercase tracking-wider">
                <tr>
                  <th className="p-3 font-semibold">Organization</th>
                  <th className="p-3 font-semibold">Plan</th>
                  <th className="p-3 font-semibold">Status</th>
                  <th className="p-3 font-semibold">Seats</th>
                  <th className="p-3 font-semibold">Last activity</th>
                  <th className="p-3 font-semibold">Connectors</th>
                  <th className="p-3 font-semibold">Billing</th>
                  <th className="p-3 font-semibold">Health</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200 text-slate-700">
                {orgs.map((org) => {
                  const dunning =
                    org.dunning === true ||
                    Boolean(org.dunningGraceEndsAt);
                  return (
                    <tr key={org.id} className="hover:bg-cream-50">
                      <td className="p-3">
                        <Link
                          href={`/admin/orgs/${org.id}`}
                          className="font-semibold text-heading hover:underline"
                        >
                          {org.name || org.slug || org.id}
                        </Link>
                        {org.slug ? (
                          <p className="text-[10px] text-slate-400 font-mono mt-0.5">{org.slug}</p>
                        ) : null}
                      </td>
                      <td className="p-3 capitalize">{org.plan || '—'}</td>
                      <td className="p-3">
                        <StatusBadge
                          label={org.status || 'unknown'}
                          tone={statusTone(org.status)}
                        />
                        {org.suspendedBy ? (
                          <p className="text-[10px] text-slate-500 mt-1">by {org.suspendedBy}</p>
                        ) : null}
                      </td>
                      <td className="p-3 font-mono">{seatsLabel(org)}</td>
                      <td className="p-3 whitespace-nowrap text-slate-500">
                        {formatActivity(org.lastActivityAt)}
                      </td>
                      <td className="p-3 font-mono">
                        {org.connectorCount == null ? '—' : org.connectorCount}
                      </td>
                      <td className="p-3">
                        {dunning ? (
                          <StatusBadge label="dunning" tone="warning" />
                        ) : (
                          <StatusBadge
                            label={org.subscriptionStatus || '—'}
                            tone="neutral"
                            icon="none"
                          />
                        )}
                      </td>
                      <td className="p-3">
                        <StatusBadge
                          label={healthLabel(org)}
                          tone={healthTone(org.health, org.healthAlertCount)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
