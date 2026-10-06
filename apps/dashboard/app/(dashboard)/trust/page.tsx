'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Check, CircleDashed, PauseCircle, PlayCircle } from 'lucide-react';
import { LiveRegion } from '@/components/a11y';
import { networkErrorMessage, responseErrorMessage } from '@/lib/client-error';

type Outcome = 'runs' | 'asks' | 'recorded';
type GroupId = 'look_up' | 'draft' | 'send_publish' | 'pay_delete' | 'sign_execute';
type Concern = 'many_turned_down' | 'often_fails' | 'approvals_expiring' | 'often_undone';

interface Requirement {
  id: string;
  have: number | null;
  need: number;
  upTo?: number;
  direction: 'at_least' | 'at_most' | 'between';
  met: boolean;
}

interface EmployeeEvidence {
  approvedAsIs: number;
  approvedEdited: number;
  rejected: number;
  expired: number;
  waiting: number;
  decided: number;
  approvalRate: number | null;
  asIsRate: number | null;
  enough: boolean;
  stillNeeded: number;
  concerns: Concern[];
  lastDecisionAt: string | null;
}

interface StageEvent {
  id: string;
  fromStage: number;
  toStage: number;
  kind: 'advance' | 'override' | 'pull_back' | 'pause';
  reason: string | null;
  by: string | null;
  at: string;
}

interface TrustData {
  canManage: boolean;
  canReview: boolean;
  stage: 0 | 1 | 2 | 3;
  killSwitch: boolean;
  since: string;
  sinceApproximate: boolean;
  levels: Array<{ stage: number; rows: Array<{ group: GroupId; outcome: Outcome }>; sameAsPrevious: boolean }>;
  recommendation: { kind: 'advance' | 'hold' | 'pull_back' | 'steady'; reasons: string[]; requirements: Requirement[] };
  workspace: { recentDecided: number; recentApprovalRate: number | null };
  employees: Array<{ id: string; name: string; role: string; status: string; evidence: EmployeeEvidence }>;
  unattributed: EmployeeEvidence;
  outcomesTracked: boolean;
  history: StageEvent[];
}

interface ShadowItem {
  id: string;
  employee: string;
  what: string;
  at: string;
}

interface ShadowState {
  items: ShadowItem[];
  waiting: number;
  reviewed: number;
  agreed: number;
}

const LEVEL_NAMES = ['Watching', 'Drafting', 'Established', 'Trusted'] as const;

const LEVEL_BLURBS = [
  'Looks things up and writes down what it would do, but does nothing else.',
  'Writes drafts and notes on its own. Anything that reaches a customer or moves money waits for a person.',
  'A team with a track record.',
  'The highest level.',
];

const GROUP_LABELS: Record<GroupId, string> = {
  look_up: 'Look things up',
  draft: 'Write drafts and save notes',
  send_publish: 'Send messages and share files',
  pay_delete: 'Take payments, refund or delete records',
  sign_execute: 'Sign documents or run commands',
};

const OUTCOME_LABELS: Record<Outcome, string> = {
  runs: 'Does it on its own',
  asks: 'Asks you first',
  recorded: 'Only writes down what it would do',
};

const CONCERN_LABELS: Record<Concern, string> = {
  many_turned_down: 'Most of what it proposes is turned down',
  often_fails: 'Approved actions often fail to run',
  approvals_expiring: 'Approvals are expiring unanswered',
  often_undone: 'Actions are often undone or complained about',
};

const KIND_LABELS: Record<StageEvent['kind'], string> = {
  advance: 'Moved up',
  override: 'Moved up early',
  pull_back: 'Moved back',
  pause: 'Paused',
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function requirementText(r: Requirement): { label: string; progress: string | null; hint?: string } {
  switch (r.id) {
    case 'shadow_reviewed':
      return { label: `Reviewed ${r.have ?? 0} of ${r.need} of your team’s watching-mode decisions`, progress: null };
    case 'shadow_agreement':
      return { label: `You agreed with at least ${pct(r.need)} of them`, progress: r.have === null ? 'None reviewed yet' : `${pct(r.have)} so far` };
    case 'weeks_in_stage':
      return { label: `At least ${r.need} weeks at this level`, progress: `${(r.have ?? 0).toFixed(1)} weeks so far` };
    case 'no_divergences':
      return { label: 'No unresolved mismatches between what was expected and what happened', progress: `${r.have ?? 0} open` };
    case 'approval_band':
      return {
        label: `Between ${pct(r.need)} and ${pct(r.upTo ?? 0.9)} of proposed actions approved`,
        progress: r.have === null ? 'No decisions yet' : `${pct(r.have)} so far`,
        hint: r.have !== null && r.upTo !== undefined && r.have > r.upTo ? 'Above 90% usually means actions are approved without a real look.' : undefined,
      };
    case 'gated_decisions':
      return { label: `At least ${r.need} decisions made by your people`, progress: `${r.have ?? 0} so far` };
    case 'approval_floor':
      return { label: `At least ${pct(r.need)} of proposed actions approved`, progress: r.have === null ? 'No decisions yet' : `${pct(r.have)} so far` };
    default:
      return { label: 'A requirement', progress: null };
  }
}

function RequirementList({ items }: { items: Requirement[] }) {
  return (
    <ul className="space-y-2" aria-label="What is needed to move up">
      {items.map((r) => {
        const t = requirementText(r);
        return (
          <li key={r.id} className="flex items-start gap-2 text-sm text-slate-700">
            {r.met ? (
              <Check className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" aria-label="Done" role="img" />
            ) : (
              <CircleDashed className="w-4 h-4 mt-0.5 text-slate-400 shrink-0" aria-label="Still needed" role="img" />
            )}
            <span>
              <span>{t.label}</span>
              {t.progress ? <span className="ml-2 text-xs font-semibold text-slate-500">{t.progress}</span> : null}
              {t.hint ? <span className="block text-xs text-amber-800">{t.hint}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default function TrustPage() {
  const [data, setData] = useState<TrustData | null>(null);
  const [shadow, setShadow] = useState<ShadowState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [earlyOpen, setEarlyOpen] = useState(false);
  const [backOpen, setBackOpen] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/trust');
      if (!res.ok) throw new Error(await responseErrorMessage(res, 'We couldn’t load your team’s track record. Please try again.'));
      setData((await res.json()) as TrustData);
    } catch (err: unknown) {
      setError(networkErrorMessage(err, 'We couldn’t load your team’s track record. Please try again.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadShadow = useCallback(async () => {
    try {
      const res = await fetch('/api/trust/shadow');
      if (!res.ok) return;
      setShadow((await res.json()) as ShadowState);
    } catch {
      /* the review list is optional: the rest of the page still works without it */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadShadow();
  }, [load, loadShadow]);

  const changeLevel = async (stage: number, extra: Record<string, unknown> = {}) => {
    setBusy('level');
    setError(null);
    try {
      const res = await fetch('/api/org/rollout', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage, ...extra }),
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res, 'We couldn’t change the level. Please try again.'));
      setEarlyOpen(false);
      setBackOpen(false);
      setReason('');
      setNotice(`Your team is now at level ${stage}.`);
      await load();
    } catch (err: unknown) {
      setError(networkErrorMessage(err, 'We couldn’t change the level. Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  const setPaused = async (enabled: boolean) => {
    setBusy('pause');
    setError(null);
    try {
      const res = await fetch('/api/org/kill-switch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res, 'We couldn’t change that. Please try again.'));
      setNotice(enabled ? 'Your team is paused.' : 'Your team is running again.');
      await load();
    } catch (err: unknown) {
      setError(networkErrorMessage(err, 'We couldn’t change that. Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  const answer = async (item: ShadowItem, agreed: boolean) => {
    setBusy(`review-${item.id}`);
    setError(null);
    try {
      const res = await fetch('/api/trust/shadow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, agreed }),
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res, 'We couldn’t save your answer. Please try again.'));
      const counts = (await res.json()) as { waiting: number; reviewed: number; agreed: number };
      setShadow((prev) => ({
        items: (prev?.items ?? []).filter((i) => i.id !== item.id),
        waiting: counts.waiting,
        reviewed: counts.reviewed,
        agreed: counts.agreed,
      }));
    } catch (err: unknown) {
      setError(networkErrorMessage(err, 'We couldn’t save your answer. Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <p className="text-sm text-slate-500">Loading your team’s track record…</p>;

  if (!data) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error ?? 'We couldn’t load your team’s track record. Please try again.'}
        </div>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            void load();
          }}
          className="rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-800"
        >
          Try again
        </button>
      </div>
    );
  }

  const { stage, recommendation: rec } = data;
  const level = data.levels.find((l) => l.stage === stage) ?? data.levels[0];
  const next = stage < 3 ? stage + 1 : null;
  const below = stage > 0 ? stage - 1 : null;

  // Show the review counter the person is looking at, not the number from when the page loaded.
  const liveRequirements = rec.requirements.map((r) => {
    if (!shadow) return r;
    if (r.id === 'shadow_reviewed') return { ...r, have: shadow.reviewed, met: shadow.reviewed >= r.need };
    if (r.id === 'shadow_agreement') {
      const have = shadow.reviewed > 0 ? shadow.agreed / shadow.reviewed : null;
      return { ...r, have, met: have !== null && have >= r.need };
    }
    return r;
  });

  const showReview = stage === 0 || (shadow?.waiting ?? 0) > 0;
  const people = data.employees;

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-12">
      <div>
        <h1 className="text-3xl font-serif font-bold text-heading flex items-center gap-2">
          <BadgeCheck className="w-7 h-7 text-amber-700" aria-hidden="true" />
          Trust
        </h1>
        <p className="text-slate-500 text-sm mt-1">How much your team can do on its own, and the evidence behind it.</p>
      </div>

      <LiveRegion message={notice} />
      {error ? (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {data.killSwitch ? (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-center justify-between gap-3">
          <p>Your team is paused. It stays at level 0 and does nothing until you resume it.</p>
          {data.canManage ? (
            <button
              type="button"
              disabled={busy === 'pause'}
              onClick={() => void setPaused(false)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-60"
            >
              <PlayCircle className="w-4 h-4" aria-hidden="true" />
              Resume my team
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-serif font-bold text-heading">
              Level {stage} · {LEVEL_NAMES[stage]}
            </h2>
            <p className="text-sm text-slate-600 mt-1">{LEVEL_BLURBS[stage]}</p>
            <p className="text-xs text-slate-400 mt-1">
              {data.sinceApproximate ? 'At this level since about ' : 'At this level since '}
              {when(data.since)}
            </p>
          </div>
          {data.canManage && !data.killSwitch ? (
            <button
              type="button"
              disabled={busy === 'pause'}
              onClick={() => void setPaused(true)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-cream-100 disabled:opacity-60"
            >
              <PauseCircle className="w-4 h-4" aria-hidden="true" />
              Pause my team
            </button>
          ) : null}
        </div>

        <ul className="divide-y divide-cream-200 border border-cream-200 rounded-2xl" aria-label="What your team can do at this level">
          {level.rows.map((row) => (
            <li key={row.group} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span className="text-slate-800">{GROUP_LABELS[row.group]}</span>
              <span
                className={`text-xs font-semibold px-2 py-1 rounded-lg ${
                  row.outcome === 'runs' ? 'bg-emerald-100 text-emerald-800' : row.outcome === 'asks' ? 'bg-sky-100 text-sky-800' : 'bg-slate-200 text-slate-700'
                }`}
              >
                {OUTCOME_LABELS[row.outcome]}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-slate-500">
          Anything that reaches a customer, moves money, or signs for you always waits for a person, at every level.
        </p>
        {level.sameAsPrevious && below !== null ? (
          <p className="text-xs text-amber-800">
            This level allows the same as level {below} today. Moving up is recorded as your team’s track record; it does not unlock more yet.
          </p>
        ) : null}
      </section>

      <section className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-4">
        {rec.kind === 'advance' && next !== null ? (
          <>
            <h3 className="text-lg font-semibold text-heading">Ready for level {next}</h3>
            <RequirementList items={liveRequirements} />
            {data.canManage ? (
              <button
                type="button"
                disabled={busy === 'level'}
                onClick={() => void changeLevel(next)}
                className="rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-60"
              >
                Move to level {next}
              </button>
            ) : null}
          </>
        ) : null}

        {rec.kind === 'hold' && next !== null ? (
          <>
            <h3 className="text-lg font-semibold text-heading">Not yet ready for level {next}</h3>
            {liveRequirements.length > 0 ? <RequirementList items={liveRequirements} /> : null}
            {data.canManage && !data.killSwitch ? (
              earlyOpen ? (
                <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
                  <p className="text-sm text-amber-900">
                    The requirements above are not met. This will be recorded as moved up early, with your reason.
                  </p>
                  <label className="block text-sm text-slate-700">
                    Why are you moving up early?
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      maxLength={500}
                      rows={2}
                      className="mt-1 block w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy === 'level'}
                      onClick={() => void changeLevel(next, { force: true, reason: reason.trim() || undefined })}
                      className="rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-60"
                    >
                      Confirm: move to level {next}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEarlyOpen(false)}
                      className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-cream-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEarlyOpen(true)}
                  className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-cream-100"
                >
                  Move up anyway
                </button>
              )
            ) : null}
          </>
        ) : null}

        {rec.kind === 'pull_back' && below !== null ? (
          <>
            <h3 className="text-lg font-semibold text-heading">We suggest moving back to level {below}</h3>
            <p className="text-sm text-slate-700">
              Over the last 30 days, {data.workspace.recentApprovalRate === null ? 'little' : pct(data.workspace.recentApprovalRate)} of the{' '}
              {data.workspace.recentDecided} actions your team proposed were approved. People turned down most of the rest.
            </p>
          </>
        ) : null}

        {rec.kind === 'steady' ? <h3 className="text-lg font-semibold text-heading">Your team is at the highest level</h3> : null}

        {rec.kind === 'hold' && rec.reasons.includes('paused') ? (
          <h3 className="text-lg font-semibold text-heading">Moving up is on hold until you resume</h3>
        ) : null}

        {!data.canManage ? <p className="text-sm text-slate-500">Only an owner or admin can change your team’s level.</p> : null}

        {data.canManage && below !== null && !data.killSwitch ? (
          backOpen ? (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 p-3 text-sm">
              <span>Move your team back to level {below}?</span>
              <button
                type="button"
                disabled={busy === 'level'}
                onClick={() => void changeLevel(below)}
                className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-60"
              >
                Yes, move back
              </button>
              <button
                type="button"
                onClick={() => setBackOpen(false)}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-cream-100"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setBackOpen(true)}
              className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                rec.kind === 'pull_back' ? 'bg-amber-700 text-white hover:bg-amber-800' : 'border border-slate-300 text-slate-700 hover:bg-cream-100'
              }`}
            >
              Move back to level {below}
            </button>
          )
        ) : null}
      </section>

      {showReview ? (
        <section className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xl font-serif font-bold text-heading">Would you have done the same?</h2>
            {shadow ? (
              <p className="text-xs font-semibold text-slate-500">
                {shadow.reviewed} reviewed · {shadow.agreed} agreed
              </p>
            ) : null}
          </div>
          {shadow && shadow.items.length > 0 ? (
            <ul className="divide-y divide-cream-200 border border-cream-200 rounded-2xl" aria-label="Decisions waiting for your answer">
              {shadow.items.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-800">
                      {item.employee}: {item.what}
                    </p>
                    <p className="text-xs text-slate-400">{when(item.at)}</p>
                  </div>
                  {data.canReview ? (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy === `review-${item.id}`}
                        onClick={() => void answer(item, true)}
                        className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
                      >
                        Yes, same
                      </button>
                      <button
                        type="button"
                        disabled={busy === `review-${item.id}`}
                        onClick={() => void answer(item, false)}
                        className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-cream-100 disabled:opacity-60"
                      >
                        No, I wouldn’t
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-500">
              {stage === 0
                ? 'Nothing is waiting for your answer. When your team is asked to do something that reaches beyond your workspace, it writes it down here instead of doing it.'
                : 'Nothing is waiting for your answer.'}
            </p>
          )}
        </section>
      ) : null}

      <section className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-4">
        <h2 className="text-xl font-serif font-bold text-heading">How each employee is doing</h2>
        <p className="text-xs text-slate-500">The last 30 days. Only decisions a person made count: approved, edited, or turned down.</p>
        {people.length === 0 ? (
          <p className="text-sm text-slate-500">You have no employees yet.</p>
        ) : (
          <ul className="divide-y divide-cream-200 border border-cream-200 rounded-2xl" aria-label="Employees and their track record">
            {people.map((p) => {
              const e = p.evidence;
              return (
                <li key={p.id} className="px-4 py-3 space-y-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-heading">{p.name}</span>
                    <span className="text-xs text-slate-400">{p.role}</span>
                  </div>
                  {e.enough && e.approvalRate !== null ? (
                    <p className="text-sm text-slate-700">
                      {pct(e.approvalRate)} approved ({e.decided} decisions)
                      {e.asIsRate !== null ? `, ${pct(e.asIsRate)} without changes` : ''}
                      {e.rejected > 0 ? `, ${e.rejected} turned down` : ''}
                    </p>
                  ) : (
                    <p className="text-sm text-slate-500">
                      {e.decided === 0 ? 'No decisions yet.' : `${e.decided} so far.`} {e.stillNeeded} more decisions are needed before this is a track record.
                    </p>
                  )}
                  {e.concerns.length > 0 ? (
                    <ul className="flex flex-wrap gap-2 pt-1" aria-label={`Concerns about ${p.name}`}>
                      {e.concerns.map((c) => (
                        <li key={c} className="text-xs font-semibold px-2 py-1 rounded-lg bg-amber-100 text-amber-900">
                          {CONCERN_LABELS[c]}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {!data.outcomesTracked ? (
          <p className="text-xs text-slate-500">
            We don’t yet record when an action is undone or a customer complains, so those can’t count for or against your team here.
          </p>
        ) : null}
      </section>

      <section className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-4">
        <h2 className="text-xl font-serif font-bold text-heading">History</h2>
        {data.history.length === 0 ? (
          <p className="text-sm text-slate-500">No changes have been recorded yet.</p>
        ) : (
          <ul className="divide-y divide-cream-200 border border-cream-200 rounded-2xl" aria-label="Changes to your team’s level">
            {data.history.map((h) => (
              <li key={h.id} className="px-4 py-3 text-sm space-y-0.5">
                <p className="text-slate-800">
                  <span className="font-semibold">{KIND_LABELS[h.kind]}</span> · Level {h.fromStage} → {h.toStage} · {when(h.at)}
                  {h.by ? <> · {h.by}</> : null}
                </p>
                {h.reason ? <p className="text-xs text-slate-500">{h.reason}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
