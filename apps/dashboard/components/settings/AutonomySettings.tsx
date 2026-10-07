'use client';

import { humanizeId } from '@/lib/humanize-id';
import React, { useCallback, useEffect, useState } from 'react';
import { useLiveRefresh } from '@/lib/use-live-refresh';
import { Shield, Clock, Ban } from 'lucide-react';
import { LiveRegion } from '@/components/a11y';
import { networkErrorMessage } from '@/lib/client-error';

type AutonomyRule = {
  id: string;
  actionType: string;
  employeeRole: string | null;
  autonomyTier: number;
  reversibility: string;
  requiresHumanApproval: boolean;
  confidenceThreshold?: number | null;
  locked: boolean;
  updatedAt: string;
};

type PendingAction = {
  id: string;
  actionType: string;
  employeeRole: string;
  ageHours: number;
  expiresAt: string | null;
};

type Suppression = {
  id: string;
  employeeRole: string;
  dimension: string;
  patternKey: string;
  rejectionCount: number;
  dismissed: boolean;
};

const TIER_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1, label: 'Notice' },
  { value: 2, label: 'Draft' },
  { value: 3, label: 'Act internally' },
  { value: 4, label: 'Act externally' },
];

/** Parse a 0-1 confidence input. Empty = not set (null); out of range / NaN = undefined (invalid). */
export function parseConfidence(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

const EMPTY_NEW_RULE = { actionType: '', employeeRole: '', tier: 2, reversibility: 'reversible', confidence: '' };

function formatExpiresAt(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'expired';
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d left`;
  if (hours >= 1) return `${hours}h left`;
  const mins = Math.max(1, Math.floor(ms / 60_000));
  return `${mins}m left`;
}

const AUTONOMY_EVENTS = [
  'settings_updated',
  'plan_updated',
  'work_item_updated',
  'needs_attention',
] as const;

export function AutonomySettings() {
  const [rules, setRules] = useState<AutonomyRule[]>([]);
  const [pending, setPending] = useState<PendingAction[]>([]);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState('');
  const [error, setError] = useState('');
  const [savingRuleId, setSavingRuleId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { confidence?: string; reversibility?: string }>>({});
  const [newRule, setNewRule] = useState(EMPTY_NEW_RULE);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setError('');
    }
    try {
      const [a, p, s] = await Promise.all([
        fetch('/api/settings/autonomy'),
        fetch('/api/settings/pending'),
        fetch('/api/settings/suppressions'),
      ]);
      if (quiet && !(a.ok && p.ok && s.ok)) {
        // A failed background refresh keeps the last good lists on screen.
        console.error('[autonomy] live refresh failed', a.status, p.status, s.status);
        return;
      }
      const autonomy = a.ok ? await a.json() : { rules: [] };
      const pendingData = p.ok ? await p.json() : { pending: [] };
      const suppressionData = s.ok ? await s.json() : { suppressions: [] };
      setRules(Array.isArray(autonomy.rules) ? autonomy.rules : []);
      setPending(Array.isArray(pendingData.pending) ? pendingData.pending : []);
      setSuppressions(Array.isArray(suppressionData.suppressions) ? suppressionData.suppressions : []);
      if (!a.ok || !p.ok || !s.ok) {
        setError('Some settings could not be loaded. Refresh to try again.');
      }
    } catch (err: unknown) {
      setError(networkErrorMessage(err, 'Network error loading settings'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useLiveRefresh({ events: AUTONOMY_EVENTS, refetch: () => load(true) });

  const updateTier = async (rule: AutonomyRule, nextTier: number) => {
    if (nextTier === rule.autonomyTier) return;
    if (nextTier < 1 || nextTier > 4) return;

    setSavingRuleId(rule.id);
    setError('');
    try {
      const res = await fetch('/api/settings/autonomy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: rule.actionType,
          employeeRole: rule.employeeRole,
          autonomyTier: nextTier,
          // Always echo current reversibility — omitting it defaults the API to reversible.
          reversibility: rule.locked ? 'irreversible' : rule.reversibility,
          ...(typeof rule.confidenceThreshold === 'number'
            ? { confidenceThreshold: rule.confidenceThreshold }
            : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Could not update autonomy tier');
        return;
      }
      setLive(`Tier updated to ${TIER_OPTIONS.find((t) => t.value === nextTier)?.label ?? nextTier}`);
      setRules((prev) =>
        prev.map((row) =>
          row.id === rule.id
            ? {
                ...row,
                autonomyTier: nextTier,
                requiresHumanApproval: nextTier < 4,
                updatedAt: new Date().toISOString(),
              }
            : row
        )
      );
    } catch (err: unknown) {
      setError(networkErrorMessage(err, 'Network error updating autonomy tier'));
    } finally {
      setSavingRuleId(null);
    }
  };

  // Saves confidence threshold + reversibility for an existing rule (tier is echoed unchanged).
  const saveRuleDetails = async (rule: AutonomyRule) => {
    const draft = drafts[rule.id] || {};
    const confidence = parseConfidence(draft.confidence ?? (typeof rule.confidenceThreshold === 'number' ? String(rule.confidenceThreshold) : ''));
    if (confidence === undefined) {
      setError('Confidence must be a number between 0 and 1');
      return;
    }
    const reversibility = rule.locked ? 'irreversible' : draft.reversibility ?? rule.reversibility;
    setSavingRuleId(rule.id);
    setError('');
    try {
      const res = await fetch('/api/settings/autonomy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType: rule.actionType,
          employeeRole: rule.employeeRole,
          autonomyTier: rule.autonomyTier,
          reversibility,
          ...(confidence != null ? { confidenceThreshold: confidence } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Could not update rule');
        return;
      }
      setLive(`Rule ${humanizeId(rule.actionType)} updated`);
      setRules((prev) =>
        prev.map((row) =>
          row.id === rule.id
            ? { ...row, reversibility, confidenceThreshold: confidence ?? row.confidenceThreshold, locked: reversibility === 'irreversible', updatedAt: new Date().toISOString() }
            : row
        )
      );
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[rule.id];
        return next;
      });
    } catch (err: unknown) {
      setError(networkErrorMessage(err, 'Network error updating rule'));
    } finally {
      setSavingRuleId(null);
    }
  };

  const createRule = async (e: React.FormEvent) => {
    e.preventDefault();
    const actionType = newRule.actionType.trim();
    if (!actionType) {
      setError('Action type is required');
      return;
    }
    const confidence = parseConfidence(newRule.confidence);
    if (confidence === undefined) {
      setError('Confidence must be a number between 0 and 1');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/settings/autonomy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionType,
          employeeRole: newRule.employeeRole.trim() || null,
          autonomyTier: newRule.tier,
          reversibility: newRule.reversibility,
          ...(confidence != null ? { confidenceThreshold: confidence } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Could not create rule');
        return;
      }
      setLive(`Rule ${actionType} saved`);
      setNewRule(EMPTY_NEW_RULE);
      await load();
    } catch (err: unknown) {
      setError(networkErrorMessage(err, 'Network error creating rule'));
    } finally {
      setCreating(false);
    }
  };

  const resolvePending = async (id: string, status: 'approved' | 'rejected') => {
    setResolvingId(id);
    setError('');
    try {
      const res = await fetch('/api/decisions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : `Could not ${status === 'approved' ? 'approve' : 'reject'} decision`);
        return;
      }
      setLive(status === 'approved' ? 'Decision approved' : 'Decision rejected');
      setPending((prev) => prev.filter((row) => row.id !== id));
    } catch (err: unknown) {
      setError(networkErrorMessage(err, `Network error resolving decision`));
    } finally {
      setResolvingId(null);
    }
  };

  const dismiss = async (id: string) => {
    try {
      const res = await fetch('/api/settings/suppressions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        setLive('Suppression dismissed');
        setSuppressions((prev) => prev.map((row) => (row.id === id ? { ...row, dismissed: true } : row)));
      } else {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === 'string' ? body.error : 'Could not dismiss suppression');
      }
    } catch (err: unknown) {
      setError(networkErrorMessage(err, 'Network error dismissing suppression'));
    }
  };

  return (
    <div className="space-y-8">
      <LiveRegion message={live} />
      {error ? (
        <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
          {error}
        </p>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-heading" />
          <h2 className="font-serif font-bold text-heading text-lg">Autonomy</h2>
        </div>
        <p className="text-xs text-slate-500">Each action type, its current mode, last changed.</p>
        {loading ? (
          <div className="h-24 bg-cream-200/50 rounded-2xl animate-pulse border border-cream-300" />
        ) : rules.length === 0 ? (
          <p className="text-sm text-slate-500">No autonomy rules yet. Defaults apply.</p>
        ) : (
          <ul className="space-y-2">
            {rules.map((rule) => (
              <li key={rule.id} className="bg-white border border-cream-300 rounded-2xl p-4 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-2">
                  <div>
                    <p className="text-sm font-semibold text-heading">{humanizeId(rule.actionType)}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      Tier {rule.autonomyTier}
                      {rule.requiresHumanApproval ? ' · needs you' : ' · auto'}
                      {rule.employeeRole ? ` · ${rule.employeeRole}` : ''}
                    </p>
                    {rule.locked && (
                      <p className="text-xs text-amber-700 mt-1">
                        {rule.actionType.includes('refund')
                          ? 'Refunds always need you.'
                          : 'Always needs you — irreversible.'}
                      </p>
                    )}
                  </div>
                  <label className="flex flex-col gap-1 max-w-xs">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Mode</span>
                    <select
                      aria-label={`Autonomy tier for ${humanizeId(rule.actionType)}`}
                      value={rule.autonomyTier}
                      disabled={savingRuleId === rule.id}
                      onChange={(e) => updateTier(rule, Number(e.target.value))}
                      className="text-sm border border-cream-300 rounded-xl px-3 py-2 bg-cream-50 text-heading disabled:opacity-60"
                    >
                      {TIER_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.value} — {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Min confidence (0-1)</span>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        aria-label={`Confidence threshold for ${humanizeId(rule.actionType)}`}
                        value={drafts[rule.id]?.confidence ?? (typeof rule.confidenceThreshold === 'number' ? String(rule.confidenceThreshold) : '')}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [rule.id]: { ...prev[rule.id], confidence: e.target.value } }))}
                        className="w-28 text-sm border border-cream-300 rounded-xl px-3 py-2 bg-cream-50 text-heading"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Reversibility</span>
                      <select
                        aria-label={`Reversibility for ${humanizeId(rule.actionType)}`}
                        value={rule.locked ? 'irreversible' : drafts[rule.id]?.reversibility ?? rule.reversibility}
                        disabled={rule.locked}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [rule.id]: { ...prev[rule.id], reversibility: e.target.value } }))}
                        className="text-sm border border-cream-300 rounded-xl px-3 py-2 bg-cream-50 text-heading disabled:opacity-60"
                      >
                        <option value="reversible">Reversible</option>
                        <option value="irreversible">Irreversible</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      aria-label={`Save details for ${humanizeId(rule.actionType)}`}
                      disabled={savingRuleId === rule.id || !drafts[rule.id]}
                      onClick={() => saveRuleDetails(rule)}
                      className="px-4 py-2 rounded-xl bg-cream-200 text-heading text-xs font-bold disabled:opacity-60"
                    >
                      Save
                    </button>
                  </div>
                </div>
                <span className="text-[10px] text-slate-400 shrink-0">{new Date(rule.updatedAt).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-heading">Add a rule</h3>
        <form noValidate onSubmit={createRule} className="bg-white border border-cream-300 rounded-2xl p-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Action type</span>
            <input
              type="text"
              aria-label="New rule action type"
              value={newRule.actionType}
              onChange={(e) => setNewRule((p) => ({ ...p, actionType: e.target.value }))}
              placeholder="e.g. gmail.send_email"
              maxLength={120}
              className="text-sm border border-cream-300 rounded-xl px-3 py-2 bg-cream-50 text-heading"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Employee role (optional)</span>
            <input
              type="text"
              aria-label="New rule employee role"
              value={newRule.employeeRole}
              onChange={(e) => setNewRule((p) => ({ ...p, employeeRole: e.target.value }))}
              maxLength={60}
              className="w-40 text-sm border border-cream-300 rounded-xl px-3 py-2 bg-cream-50 text-heading"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Mode</span>
            <select
              aria-label="New rule autonomy tier"
              value={newRule.tier}
              onChange={(e) => setNewRule((p) => ({ ...p, tier: Number(e.target.value) }))}
              className="text-sm border border-cream-300 rounded-xl px-3 py-2 bg-cream-50 text-heading"
            >
              {TIER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.value} — {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Reversibility</span>
            <select
              aria-label="New rule reversibility"
              value={newRule.reversibility}
              onChange={(e) => setNewRule((p) => ({ ...p, reversibility: e.target.value }))}
              className="text-sm border border-cream-300 rounded-xl px-3 py-2 bg-cream-50 text-heading"
            >
              <option value="reversible">Reversible</option>
              <option value="irreversible">Irreversible</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Min confidence (0-1)</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              aria-label="New rule confidence threshold"
              value={newRule.confidence}
              onChange={(e) => setNewRule((p) => ({ ...p, confidence: e.target.value }))}
              placeholder="0.85"
              className="w-28 text-sm border border-cream-300 rounded-xl px-3 py-2 bg-cream-50 text-heading"
            />
          </label>
          <button
            type="submit"
            disabled={creating}
            className="px-4 py-2 rounded-xl bg-amber-500 text-heading text-xs font-bold disabled:opacity-60"
          >
            Add rule
          </button>
        </form>
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-heading" />
          <h2 className="font-serif font-bold text-heading text-lg">Pending</h2>
        </div>
        <p className="text-xs text-slate-500">Everything awaiting approval, with age. Expiry never approves.</p>
        {pending.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing waiting.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((row) => {
              const countdown = formatExpiresAt(row.expiresAt);
              return (
                <li key={row.id} className="bg-white border border-cream-300 rounded-2xl p-4 space-y-3">
                  <div>
                    <p className="text-sm font-semibold text-heading">{humanizeId(row.actionType)}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      {row.employeeRole} · {row.ageHours.toFixed(1)} hours old
                      {row.ageHours >= 24 ? ' · overdue for a reminder' : ''}
                      {countdown ? ` · ${countdown}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={resolvingId === row.id}
                      onClick={() => resolvePending(row.id, 'approved')}
                      className="px-4 py-2 rounded-xl bg-amber-500 text-heading text-xs font-bold disabled:opacity-60"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={resolvingId === row.id}
                      onClick={() => resolvePending(row.id, 'rejected')}
                      className="px-4 py-2 rounded-xl bg-cream-200 text-heading text-xs font-bold disabled:opacity-60"
                    >
                      Reject
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Ban className="w-4 h-4 text-heading" />
          <h2 className="font-serif font-bold text-heading text-lg">Suppressions</h2>
        </div>
        <p className="text-xs text-slate-500">What the employee has stopped showing, and why. Removable.</p>
        {suppressions.length === 0 ? (
          <p className="text-sm text-slate-500">No learned filters.</p>
        ) : (
          <ul className="space-y-2">
            {suppressions.map((row) => (
              <li key={row.id} className="bg-white border border-cream-300 rounded-2xl p-4 flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-heading">{row.patternKey}</p>
                  <p className="text-xs text-slate-500 mt-1">
                    {row.dimension} · {row.employeeRole} · {row.rejectionCount}×
                    {row.dismissed ? ' · dismissed' : ''}
                  </p>
                </div>
                {!row.dismissed && (
                  <button
                    type="button"
                    onClick={() => dismiss(row.id)}
                    className="text-xs font-semibold text-slate-600 underline"
                  >
                    Dismiss
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
