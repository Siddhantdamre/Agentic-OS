'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeft,
  ExternalLink,
  Shield,
  Users,
  Gauge,
  Plug,
  ScrollText,
  CreditCard,
  AlertTriangle,
} from 'lucide-react';
import { StatusBadge, type StatusTone } from '@/components/a11y';
import {
  ConfirmReasonDialog,
  canOperate,
  fetchPlatformOrg,
  isSupportOnly,
  platformMutate,
  putOrgOverrides,
  razorpaySubscriptionUrl,
  startImpersonation,
  stripeCustomerUrl,
} from '@/components/platform';
import type {
  PlatformMeter,
  PlatformOrgDetail,
  PlatformOverrides,
  PlatformRole,
} from '@/components/platform/types';
import {
  METER_KINDS,
  PLATFORM_FEATURE_FLAG_KEYS,
  PLATFORM_FEATURE_FLAG_SAFETY,
} from '@/components/platform/types';

type PendingAction =
  | { kind: 'suspend' }
  | { kind: 'unsuspend' }
  | { kind: 'soft-delete' }
  | { kind: 'kill-switch'; enabled: boolean }
  | { kind: 'disconnect'; connectorId: string; label: string }
  | { kind: 'revoke'; userId: string; email?: string | null }
  | { kind: 'overrides' }
  | {
      kind: 'impersonate';
      userId: string;
      email?: string | null;
      breakGlass: boolean;
    };

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

function meterLabel(kind: string): string {
  switch (kind) {
    case 'llm_tokens':
      return 'LLM tokens';
    case 'whatsapp_conversations':
      return 'WhatsApp conversations';
    case 'seats':
      return 'Seats';
    case 'embeddings':
      return 'Embeddings';
    case 'successful_actions':
      return 'Successful actions';
    case 'disconnected_actions':
      return 'Disconnected actions';
    default:
      return kind;
  }
}

function formatMoney(amountMinor: number, currency: string): string {
  const value = amountMinor / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export default function PlatformOrgDetailPage() {
  const params = useParams();
  const orgId = typeof params?.orgId === 'string' ? params.orgId : '';

  const [org, setOrg] = useState<PlatformOrgDetail | null>(null);
  const [platformRole, setPlatformRole] = useState<PlatformRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  const [seatCapDraft, setSeatCapDraft] = useState<string>('');
  const [meterHardDraft, setMeterHardDraft] = useState<Record<string, string>>({});
  const [meterSoftDraft, setMeterSoftDraft] = useState<Record<string, string>>({});
  const [featureFlagDraft, setFeatureFlagDraft] = useState<Record<string, boolean>>({});

  const operator = canOperate(platformRole);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    setForbidden(false);
    const result = await fetchPlatformOrg(orgId);
    if (!result.ok) {
      setOrg(null);
      setForbidden(result.error.forbidden || result.error.notFound);
      setError(
        result.error.forbidden || result.error.notFound
          ? 'Platform admin access required, or this org was not found.'
          : result.error.migrationMissing
            ? 'Platform tables are not available yet (migration not applied).'
            : result.error.message
      );
      setLoading(false);
      return;
    }
    setOrg(result.data);
    const role = result.platformRole ?? result.data.platformRole ?? null;
    if (role) setPlatformRole(role);
    setSeatCapDraft(
      result.data.overrides?.seatCap != null ? String(result.data.overrides.seatCap) : ''
    );
    const hardDraft: Record<string, string> = {};
    const softDraft: Record<string, string> = {};
    for (const kind of METER_KINDS) {
      const fromOverride = result.data.overrides?.meterCaps?.[kind];
      const fromMeter = result.data.meters?.find((m) => m.kind === kind);
      const hard = fromOverride?.hard ?? fromMeter?.hardLimit ?? fromMeter?.hard ?? null;
      const soft = fromOverride?.soft ?? fromMeter?.softLimit ?? fromMeter?.soft ?? null;
      hardDraft[kind] = hard != null ? String(hard) : '';
      softDraft[kind] = soft != null ? String(soft) : '';
    }
    setMeterHardDraft(hardDraft);
    setMeterSoftDraft(softDraft);
    const flags: Record<string, boolean> = {};
    for (const key of PLATFORM_FEATURE_FLAG_KEYS) {
      flags[key] = Boolean(result.data.overrides?.featureFlags?.[key]);
    }
    setFeatureFlagDraft(flags);
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runPending = async (reason: string) => {
    if (!pending || !org) return;
    setBusy(true);
    setMessage(null);

    let result;
    switch (pending.kind) {
      case 'suspend':
        result = await platformMutate(
          `/api/platform/orgs/${encodeURIComponent(org.id)}/suspend`,
          { reason }
        );
        break;
      case 'unsuspend':
        result = await platformMutate(
          `/api/platform/orgs/${encodeURIComponent(org.id)}/unsuspend`,
          { reason }
        );
        break;
      case 'soft-delete':
        result = await platformMutate(
          `/api/platform/orgs/${encodeURIComponent(org.id)}/soft-delete`,
          { reason }
        );
        break;
      case 'kill-switch':
        result = await platformMutate(
          `/api/platform/orgs/${encodeURIComponent(org.id)}/kill-switch`,
          { body: { enabled: pending.enabled }, reason }
        );
        break;
      case 'disconnect':
        result = await platformMutate(
          `/api/platform/orgs/${encodeURIComponent(org.id)}/connectors/${encodeURIComponent(pending.connectorId)}/disconnect`,
          { reason }
        );
        break;
      case 'revoke':
        result = await platformMutate(
          `/api/platform/orgs/${encodeURIComponent(org.id)}/users/${encodeURIComponent(pending.userId)}/revoke-sessions`,
          { reason }
        );
        break;
      case 'overrides': {
        const overrides: PlatformOverrides = {
          seatCap: seatCapDraft.trim() === '' ? null : Math.max(1, Number(seatCapDraft) || 1),
          meterCaps: {},
          featureFlags: {},
        };
        for (const kind of METER_KINDS) {
          const hardRaw = meterHardDraft[kind]?.trim();
          const softRaw = meterSoftDraft[kind]?.trim();
          if (!hardRaw && !softRaw) continue;
          const hard = hardRaw ? Number(hardRaw) : null;
          const soft = softRaw ? Number(softRaw) : null;
          if (hardRaw && !Number.isFinite(hard)) continue;
          if (softRaw && !Number.isFinite(soft)) continue;
          overrides.meterCaps![kind] = {
            soft: softRaw ? soft : (org.overrides?.meterCaps?.[kind]?.soft ?? null),
            hard: hardRaw ? hard : (org.overrides?.meterCaps?.[kind]?.hard ?? null),
          };
        }
        for (const key of PLATFORM_FEATURE_FLAG_KEYS) {
          overrides.featureFlags![key] = Boolean(featureFlagDraft[key]);
        }
        result = await putOrgOverrides(org.id, overrides, reason);
        break;
      }
      case 'impersonate':
        result = await startImpersonation({
          targetUserId: pending.userId,
          targetOrgId: org.id,
          reason,
          breakGlass: pending.breakGlass,
        });
        break;
      default: {
        const _exhaustive: never = pending;
        void _exhaustive;
        setBusy(false);
        return;
      }
    }

    setBusy(false);
    if (!result.ok) {
      if (result.error.forbidden) {
        setPlatformRole('support');
        setMessage('Forbidden — your platform role cannot perform this action.');
      } else {
        setMessage(result.error.message);
      }
      return;
    }

    setPending(null);
    if (pending.kind === 'impersonate') {
      setMessage('Impersonation started. Reloading as target user…');
      window.location.href = '/';
      return;
    }
    setMessage('Action completed.');
    await load();
  };

  const dialogMeta = ((): {
    title: string;
    description?: string;
    confirmLabel: string;
    danger: boolean;
    extraWarning?: string;
  } => {
    if (!pending) {
      return { title: '', confirmLabel: 'Confirm', danger: false };
    }
    switch (pending.kind) {
      case 'suspend':
        return {
          title: 'Suspend organization',
          description: 'Sets status to suspended with suspended_by = platform.',
          confirmLabel: 'Suspend org',
          danger: true,
        };
      case 'unsuspend':
        return {
          title: 'Clear platform suspension',
          description: 'Only works when suspended_by is platform.',
          confirmLabel: 'Unsuspend',
          danger: false,
        };
      case 'soft-delete':
        return {
          title: 'Soft-delete organization',
          description: 'Marks soft_deleted. Does not purge data.',
          confirmLabel: 'Soft-delete',
          danger: true,
        };
      case 'kill-switch':
        return {
          title: pending.enabled ? 'Enable autonomy kill switch' : 'Clear autonomy kill switch',
          description: pending.enabled
            ? 'Sets org_runtime_controls.kill_switch = true (and orgs.meta). Does not suspend the org.'
            : 'Clears the platform kill switch so autonomy can run again (within plan limits).',
          confirmLabel: pending.enabled ? 'Enable kill switch' : 'Clear kill switch',
          danger: pending.enabled,
        };
      case 'disconnect':
        return {
          title: 'Force-disconnect connector',
          description: `Disconnect ${pending.label}. Customer audit will also record connector.disconnect.`,
          confirmLabel: 'Disconnect',
          danger: true,
        };
      case 'revoke':
        return {
          title: 'Revoke user sessions',
          description: `Increments session_epoch for ${pending.email || pending.userId}.`,
          confirmLabel: 'Revoke sessions',
          danger: true,
        };
      case 'overrides':
        return {
          title: 'Update plan overrides',
          description: 'Raises or lowers seat/meter caps for this org.',
          confirmLabel: 'Save overrides',
          danger: false,
        };
      case 'impersonate':
        return {
          title: pending.breakGlass ? 'Break-glass impersonation' : 'Start impersonation',
          description: `Act as ${pending.email || pending.userId} for up to 30 minutes. Actions are logged.`,
          confirmLabel: 'Start impersonation',
          danger: true,
          extraWarning: pending.breakGlass
            ? 'This org has not opted in to support access. Break-glass still banners and expires in 30 minutes.'
            : undefined,
        };
      default: {
        const _exhaustive: never = pending;
        void _exhaustive;
        return { title: '', confirmLabel: 'Confirm', danger: false };
      }
    }
  })();

  if (!orgId) {
    return (
      <div className="max-w-4xl mx-auto p-8 text-sm text-red-800">Missing org id.</div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div>
        <Link
          href="/admin"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-heading mb-3"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          Directory
        </Link>
        <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading flex items-center gap-2">
          <Shield className="w-7 h-7 text-amber-700" aria-hidden="true" />
          {loading ? 'Organization' : org?.name || 'Organization'}
        </h1>
        <p className="text-sm text-slate-500 mt-1 font-mono break-all">{orgId}</p>
        {platformRole ? (
          <p className="text-xs text-slate-500 mt-1">
            Platform role: <span className="font-semibold text-heading">{platformRole}</span>
            {isSupportOnly(platformRole) ? ' — operator controls hidden' : null}
          </p>
        ) : null}
      </div>

      {message ? (
        <div className="rounded-2xl border border-cream-300 bg-cream-50 p-4 text-sm text-slate-700">
          {message}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 space-y-2">
          <p>{error}</p>
          {forbidden ? (
            <p className="text-xs">This page requires a platform_admins row for your user.</p>
          ) : null}
          <button
            type="button"
            onClick={() => void load()}
            className="px-4 py-2 bg-amber-500 text-heading text-xs font-bold rounded-xl"
          >
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="p-8 text-center text-slate-500 font-serif">Loading org…</div>
      ) : org ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Status
              </span>
              <StatusBadge label={org.status} tone={statusTone(org.status)} />
              {org.suspendedBy ? (
                <p className="text-xs text-slate-500">suspended_by: {org.suspendedBy}</p>
              ) : null}
            </div>
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Plan
              </span>
              <div className="text-2xl font-bold text-heading capitalize">{org.plan || '—'}</div>
            </div>
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Kill switch
              </span>
              <div className="text-sm font-semibold text-heading">
                {org.killSwitch == null ? 'unknown' : org.killSwitch ? 'on' : 'off'}
              </div>
              <p className="text-xs text-slate-500">
                Rollout stage: {org.rolloutStage == null ? 'unknown' : org.rolloutStage}
              </p>
              {operator ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setPending({ kind: 'kill-switch', enabled: true })}
                    disabled={org.killSwitch === true || org.status === 'soft_deleted'}
                    className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-[11px] font-bold rounded-xl disabled:opacity-50"
                  >
                    Enable kill switch…
                  </button>
                  <button
                    type="button"
                    onClick={() => setPending({ kind: 'kill-switch', enabled: false })}
                    disabled={org.killSwitch !== true}
                    className="px-3 py-1.5 border border-cream-300 text-[11px] font-bold rounded-xl disabled:opacity-50"
                  >
                    Clear kill switch…
                  </button>
                </div>
              ) : null}
            </div>
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Support access
              </span>
              <div className="text-sm font-semibold text-heading">
                {org.supportAccessEnabled == null
                  ? 'unknown'
                  : org.supportAccessEnabled
                    ? 'opted in'
                    : 'not opted in'}
              </div>
            </div>
          </div>

          {operator ? (
            <div className="bg-white border border-cream-300 rounded-3xl p-5 shadow-sm space-y-3">
              <h2 className="text-lg font-serif font-bold text-heading">Incident controls</h2>
              <p className="text-xs text-slate-500">
                Each action requires a reason (≥12 chars) and explicit confirm.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setPending({ kind: 'suspend' })}
                  disabled={org.status === 'soft_deleted'}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-xl disabled:opacity-50"
                >
                  Suspend
                </button>
                <button
                  type="button"
                  onClick={() => setPending({ kind: 'unsuspend' })}
                  disabled={org.status !== 'suspended' || org.suspendedBy !== 'platform'}
                  className="px-4 py-2 border border-cream-300 text-xs font-bold rounded-xl disabled:opacity-50"
                >
                  Unsuspend
                </button>
                <button
                  type="button"
                  onClick={() => setPending({ kind: 'soft-delete' })}
                  disabled={org.status === 'soft_deleted'}
                  className="px-4 py-2 border border-red-200 text-red-700 text-xs font-bold rounded-xl disabled:opacity-50"
                >
                  Soft-delete
                </button>
              </div>
            </div>
          ) : null}

          {/* Members */}
          <section className="bg-white border border-cream-300 rounded-3xl overflow-hidden shadow-sm">
            <div className="p-5 border-b border-cream-300 flex items-center gap-2">
              <Users className="w-5 h-5 text-amber-700" aria-hidden="true" />
              <h2 className="text-lg font-serif font-bold text-heading">Members</h2>
            </div>
            {!org.members || org.members.length === 0 ? (
              <p className="p-5 text-sm text-slate-500">No members returned for this org.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs min-w-[560px]">
                  <thead className="bg-cream-100 text-slate-500 uppercase tracking-wider">
                    <tr>
                      <th className="p-3 font-semibold">Email</th>
                      <th className="p-3 font-semibold">Role</th>
                      <th className="p-3 font-semibold">Epoch</th>
                      <th className="p-3 font-semibold">Last login</th>
                      <th className="p-3 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cream-200">
                    {org.members.map((m) => (
                      <tr key={m.userId} className="hover:bg-cream-50">
                        <td className="p-3 font-semibold text-heading">{m.email || m.userId}</td>
                        <td className="p-3 capitalize">{m.role || '—'}</td>
                        <td className="p-3 font-mono">{m.sessionEpoch ?? '—'}</td>
                        <td className="p-3 text-slate-500">
                          {m.lastLoginAt
                            ? new Date(m.lastLoginAt).toLocaleString()
                            : '—'}
                        </td>
                        <td className="p-3 text-right space-x-2 whitespace-nowrap">
                          {(() => {
                            const needsBreakGlass = org.supportAccessEnabled !== true;
                            // support: consent path only. operator: break-glass allowed.
                            if (needsBreakGlass && !operator) return null;
                            return (
                              <button
                                type="button"
                                onClick={() =>
                                  setPending({
                                    kind: 'impersonate',
                                    userId: m.userId,
                                    email: m.email,
                                    breakGlass: needsBreakGlass && operator,
                                  })
                                }
                                className="text-xs font-bold text-amber-800 hover:underline"
                              >
                                Impersonate
                                {needsBreakGlass && operator ? ' (break-glass)' : ''}
                              </button>
                            );
                          })()}
                          {operator ? (
                            <button
                              type="button"
                              onClick={() =>
                                setPending({
                                  kind: 'revoke',
                                  userId: m.userId,
                                  email: m.email,
                                })
                              }
                              className="text-xs font-bold text-red-700 hover:underline"
                            >
                              Revoke sessions
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!org.supportAccessEnabled && isSupportOnly(platformRole) ? (
              <div className="px-5 pb-4 flex items-start gap-2 text-xs text-amber-900">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                Support impersonation requires org support-access opt-in. Break-glass is
                operator-only.
              </div>
            ) : null}
          </section>

          {/* Usage meters */}
          <section className="bg-white border border-cream-300 rounded-3xl p-5 shadow-sm space-y-4">
            <div className="flex items-center gap-2">
              <Gauge className="w-5 h-5 text-amber-700" aria-hidden="true" />
              <h2 className="text-lg font-serif font-bold text-heading">Usage meters</h2>
            </div>
            {org.llmCostError ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                Langfuse cost unavailable: {org.llmCostError}. Not shown as $0.
              </div>
            ) : org.llmCost != null && org.llmCost !== 'unknown' ? (
              <p className="text-sm text-slate-600">
                LLM cost:{' '}
                <span className="font-semibold text-heading">
                  ${Number(org.llmCost).toFixed(4)}
                </span>
              </p>
            ) : (
              <p className="text-sm text-slate-500">LLM cost: unknown</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {(org.meters && org.meters.length > 0
                ? org.meters
                : (METER_KINDS.map((kind) => ({
                    kind,
                    quantity: null,
                  })) as PlatformMeter[])
              ).map((m) => {
                const soft = m.softLimit ?? m.soft ?? null;
                const hard = m.hardLimit ?? m.hard ?? null;
                return (
                  <div
                    key={m.kind}
                    className={`rounded-2xl border p-4 ${
                      m.overHard
                        ? 'border-red-300 bg-red-50'
                        : m.overSoft
                          ? 'border-amber-300 bg-amber-50'
                          : 'border-cream-300 bg-cream-50'
                    }`}
                  >
                    <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                      {meterLabel(m.kind)}
                    </p>
                    <p className="text-2xl font-bold text-heading mt-1">
                      {m.quantity == null ? '—' : m.quantity}
                    </p>
                    <p className="text-[11px] text-slate-500 mt-1">
                      soft {soft ?? '—'} · hard {hard ?? '—'}
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-slate-500">
              Failed webhooks: {org.failedWebhookCount ?? 'unknown'} · Unresolved:{' '}
              {org.unresolvedWebhookCount ?? 'unknown'}
            </p>
          </section>

          {/* Overrides (operator) */}
          {operator ? (
            <section className="bg-white border border-cream-300 rounded-3xl p-5 shadow-sm space-y-4">
              <h2 className="text-lg font-serif font-bold text-heading">Plan overrides</h2>
              <p className="text-xs text-slate-500">
                Seat cap, meter soft/hard caps, and feature flags. Saving requires confirm and
                reason ≥ 12. Unknown flag keys are rejected by the API (400). Flags cannot
                disable RLS, platform audit, or confirm.
              </p>
              <label className="block max-w-xs space-y-1">
                <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Seat cap override
                </span>
                <input
                  type="number"
                  min={1}
                  value={seatCapDraft}
                  onChange={(e) => setSeatCapDraft(e.target.value)}
                  placeholder="null = subscription"
                  className="w-full px-3 py-2 bg-cream-100 border border-cream-300 rounded-xl text-sm"
                />
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {METER_KINDS.map((kind) => (
                  <div key={kind} className="rounded-2xl border border-cream-300 bg-cream-50 p-3 space-y-2">
                    <p className="text-[10px] font-bold text-slate-700 uppercase tracking-wider">
                      {meterLabel(kind)}
                    </p>
                    <label className="block space-y-1">
                      <span className="text-[10px] text-slate-500">soft</span>
                      <input
                        type="number"
                        min={0}
                        value={meterSoftDraft[kind] ?? ''}
                        onChange={(e) =>
                          setMeterSoftDraft((prev) => ({ ...prev, [kind]: e.target.value }))
                        }
                        className="w-full px-3 py-2 bg-white border border-cream-300 rounded-xl text-sm"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[10px] text-slate-500">hard</span>
                      <input
                        type="number"
                        min={0}
                        value={meterHardDraft[kind] ?? ''}
                        onChange={(e) =>
                          setMeterHardDraft((prev) => ({ ...prev, [kind]: e.target.value }))
                        }
                        className="w-full px-3 py-2 bg-white border border-cream-300 rounded-xl text-sm"
                      />
                    </label>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <p className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Feature flags
                </p>
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {PLATFORM_FEATURE_FLAG_KEYS.map((key) => (
                    <li key={key}>
                      <label className="flex items-start gap-2 rounded-2xl border border-cream-300 bg-cream-50 px-3 py-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={Boolean(featureFlagDraft[key])}
                          onChange={(e) =>
                            setFeatureFlagDraft((prev) => ({
                              ...prev,
                              [key]: e.target.checked,
                            }))
                          }
                          className="mt-0.5 accent-amber-600"
                        />
                        <span>
                          <span className="font-mono text-xs text-heading">{key}</span>
                          {PLATFORM_FEATURE_FLAG_SAFETY[key] ? (
                            <span className="ml-1 text-[10px] font-bold uppercase text-amber-800">
                              safety
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
              <button
                type="button"
                onClick={() => setPending({ kind: 'overrides' })}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-heading text-xs font-bold rounded-xl"
              >
                Save overrides…
              </button>
            </section>
          ) : (
            <section className="bg-white border border-cream-300 rounded-3xl p-5 shadow-sm space-y-3">
              <h2 className="text-lg font-serif font-bold text-heading">Plan overrides</h2>
              <p className="text-sm text-slate-600">
                Seat cap:{' '}
                {org.overrides?.seatCap ?? 'null (use subscription)'}
              </p>
              {org.overrides?.meterCaps && Object.keys(org.overrides.meterCaps).length > 0 ? (
                <div className="text-xs text-slate-600 space-y-1">
                  <p className="font-bold uppercase tracking-wider text-slate-500">Meter caps</p>
                  {Object.entries(org.overrides.meterCaps).map(([kind, caps]) => (
                    <p key={kind} className="font-mono">
                      {kind}: soft {caps?.soft ?? '—'} · hard {caps?.hard ?? '—'}
                    </p>
                  ))}
                </div>
              ) : null}
              <div className="text-xs text-slate-600 space-y-1">
                <p className="font-bold uppercase tracking-wider text-slate-500">
                  Feature flags (current)
                </p>
                {PLATFORM_FEATURE_FLAG_KEYS.map((key) => (
                  <p key={key} className="font-mono">
                    {key}: {org.overrides?.featureFlags?.[key] === true ? 'true' : 'false'}
                    {PLATFORM_FEATURE_FLAG_SAFETY[key] ? ' (safety)' : ''}
                  </p>
                ))}
              </div>
            </section>
          )}

          {/* Connectors */}
          <section className="bg-white border border-cream-300 rounded-3xl overflow-hidden shadow-sm">
            <div className="p-5 border-b border-cream-300 flex items-center gap-2">
              <Plug className="w-5 h-5 text-amber-700" aria-hidden="true" />
              <h2 className="text-lg font-serif font-bold text-heading">Connectors</h2>
            </div>
            {!org.connectors || org.connectors.length === 0 ? (
              <p className="p-5 text-sm text-slate-500">No connectors listed.</p>
            ) : (
              <ul className="divide-y divide-cream-200">
                {org.connectors.map((c) => (
                  <li
                    key={c.id}
                    className="px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <div>
                      <p className="font-semibold text-heading">{c.provider || c.id}</p>
                      <p className="text-xs text-slate-500 font-mono">{c.id}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge
                        label={c.status || 'unknown'}
                        tone={c.status === 'connected' ? 'success' : 'neutral'}
                      />
                      {operator && c.status === 'connected' ? (
                        <button
                          type="button"
                          onClick={() =>
                            setPending({
                              kind: 'disconnect',
                              connectorId: c.id,
                              label: c.provider || c.id,
                            })
                          }
                          className="text-xs font-bold text-red-700 hover:underline"
                        >
                          Force disconnect
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Billing health — link out only */}
          <section className="bg-white border border-cream-300 rounded-3xl p-5 shadow-sm space-y-4">
            <div className="flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-amber-700" aria-hidden="true" />
              <h2 className="text-lg font-serif font-bold text-heading">Billing health</h2>
            </div>
            {!org.billing ? (
              <p className="text-sm text-slate-500">No billing payload for this org.</p>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
                  <div>
                    <p className="text-xs font-bold uppercase text-slate-500">Provider</p>
                    <p className="font-semibold text-heading capitalize">
                      {org.billing.provider || '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase text-slate-500">Subscription</p>
                    <p className="font-semibold text-heading">{org.billing.status || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase text-slate-500">Seats</p>
                    <p className="font-semibold text-heading">{org.billing.seats ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold uppercase text-slate-500">Last invoice</p>
                    <p className="font-semibold text-heading">
                      {org.billing.lastInvoiceStatus || '—'}
                    </p>
                  </div>
                </div>
                {org.billing.dunningGraceEndsAt ? (
                  <p className="text-xs text-amber-800">
                    Dunning grace ends{' '}
                    {new Date(org.billing.dunningGraceEndsAt).toLocaleString()}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-3">
                  {(() => {
                    const stripeUrl = stripeCustomerUrl(org.billing.providerCustomerId);
                    const razorUrl = razorpaySubscriptionUrl(
                      org.billing.providerSubscriptionId
                    );
                    if (org.billing.provider === 'stripe' && stripeUrl) {
                      return (
                        <a
                          href={stripeUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-bold text-heading hover:underline"
                        >
                          Open in Stripe
                          <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                      );
                    }
                    if (org.billing.provider === 'razorpay' && razorUrl) {
                      return (
                        <a
                          href={razorUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-bold text-heading hover:underline"
                        >
                          Open in Razorpay
                          <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        </a>
                      );
                    }
                    return (
                      <p className="text-xs text-slate-500">
                        No processor customer id — payment method link omitted. The console never
                        edits cards.
                      </p>
                    );
                  })()}
                </div>
                {org.billing.invoices && org.billing.invoices.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-cream-100 text-slate-500 uppercase tracking-wider">
                        <tr>
                          <th className="p-2 font-semibold">Invoice</th>
                          <th className="p-2 font-semibold">Status</th>
                          <th className="p-2 font-semibold">Amount</th>
                          <th className="p-2 font-semibold">Created</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-cream-200">
                        {org.billing.invoices.map((inv) => (
                          <tr key={inv.id}>
                            <td className="p-2 font-mono text-[11px]">{inv.id}</td>
                            <td className="p-2">{inv.status || '—'}</td>
                            <td className="p-2">
                              {inv.amountMinor != null
                                ? formatMoney(inv.amountMinor, inv.currency || 'usd')
                                : '—'}
                            </td>
                            <td className="p-2 text-slate-500">
                              {inv.createdAt
                                ? new Date(inv.createdAt).toLocaleString()
                                : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </>
            )}
          </section>

          {/* Org audit */}
          <AuditTable
            title="Org audit trail"
            rows={org.orgAudit}
            empty="No org audit events returned."
          />

          {/* Platform audit */}
          <AuditTable
            title="Platform audit trail"
            rows={org.platformAudit}
            empty="No platform audit rows for this org."
          />
        </>
      ) : null}

      <ConfirmReasonDialog
        open={pending != null}
        title={dialogMeta.title}
        description={dialogMeta.description}
        orgName={org?.name}
        orgId={org?.id}
        confirmLabel={dialogMeta.confirmLabel}
        danger={dialogMeta.danger}
        extraWarning={dialogMeta.extraWarning}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={runPending}
      />
    </div>
  );
}

function AuditTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows?: PlatformOrgDetail['orgAudit'];
  empty: string;
}) {
  return (
    <section className="bg-white border border-cream-300 rounded-3xl overflow-hidden shadow-sm">
      <div className="p-5 border-b border-cream-300 flex items-center gap-2">
        <ScrollText className="w-5 h-5 text-amber-700" aria-hidden="true" />
        <h2 className="text-lg font-serif font-bold text-heading">{title}</h2>
      </div>
      {!rows || rows.length === 0 ? (
        <p className="p-5 text-sm text-slate-500">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs min-w-[640px]">
            <thead className="bg-cream-100 text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="p-3 font-semibold">Time</th>
                <th className="p-3 font-semibold">Action</th>
                <th className="p-3 font-semibold">Actor</th>
                <th className="p-3 font-semibold">Reason / preview</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-cream-50">
                  <td className="p-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                    {row.createdAt ? new Date(row.createdAt).toLocaleString() : '—'}
                  </td>
                  <td className="p-3 font-mono text-amber-800">
                    {row.action || row.kind || '—'}
                  </td>
                  <td className="p-3">
                    {row.actorUserId || row.platformRole || '—'}
                  </td>
                  <td className="p-3 text-slate-600 max-w-xs truncate">
                    {row.reason || row.payloadPreview || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
