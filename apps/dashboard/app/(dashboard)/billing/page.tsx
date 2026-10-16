'use client';

import React, { useEffect, useState } from 'react';
import { useLiveRefresh } from '@/lib/use-live-refresh';
import Link from 'next/link';
import {
  CreditCard,
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Users,
  MessageSquare,
  Cpu,
  ExternalLink,
} from 'lucide-react';
import { responseErrorMessage } from '@/lib/client-error';

type CatalogPlan = {
  key: 'starter' | 'growth' | 'enterprise';
  amountCents: number | null;
  currency: string;
  stripePriceId: string | null;
  razorpayPlanId: string | null;
};

type Invoice = {
  id: string;
  provider: string;
  amountMinor: number;
  currency: string;
  status: string;
  hostedUrl: string | null;
  createdAt: string;
  failedAt: string | null;
};

type Subscription = {
  id: string;
  provider: string;
  plan: string;
  status: string;
  seats: number;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

type Meter = {
  kind: string;
  quantity: number;
  unit: string;
  softLimit: number | null;
  hardLimit: number | null;
  overSoft: boolean;
  overHard: boolean;
  source: string;
  truncated: boolean;
};

type ConfirmReject = {
  confirmed: number;
  rejected: number;
  pending: number;
  sampleSize: number;
  rejectRate: number | null;
  highRejectFlag: boolean;
};

type BillingPayload = {
  plan: string;
  role: string;
  neverEscrow: boolean;
  providers: { stripe: boolean; razorpay: boolean };
  providerGaps?: { stripe: string[]; razorpay: string[] };
  catalog: CatalogPlan[];
  subscriptions: Subscription[];
  invoices: Invoice[];
  meters: Meter[];
  llmError: string | null;
  confirmReject: ConfirmReject | null;
  usageBlocked: boolean;
  seatsUsed: number;
  whatsappConversations: number;
  error?: string;
};

function formatMoney(amountMinor: number, currency: string): string {
  const value = amountMinor / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(
      value
    );
  } catch {
    return `${value.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

const BILLING_LOAD_FAILED = 'We couldn’t load your billing details just now. Please try again in a moment.';

function meterLabel(kind: string): string {
  switch (kind) {
    case 'llm_tokens':
      return 'AI usage';
    case 'whatsapp_conversations':
      return 'WhatsApp conversations';
    case 'seats':
      return 'Seats';
    case 'embeddings':
      return 'Knowledge indexing';
    case 'successful_actions':
      return 'Successful actions';
    case 'disconnected_actions':
      return 'Blocked: tool not connected';
    default:
      return kind;
  }
}

const BILLING_EVENTS = ['billing_updated'] as const;

export default function BillingPage() {
  const [data, setData] = useState<BillingPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [plan, setPlan] = useState<'starter' | 'growth' | 'enterprise'>('starter');
  const [provider, setProvider] = useState<'stripe' | 'razorpay'>('stripe');
  const [seats, setSeats] = useState(1);

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await fetch('/api/billing');
      const json = (await res.json().catch(() => ({}))) as BillingPayload & { error?: string };
      if (quiet && (!res.ok || !json.providers || !Array.isArray(json.catalog))) {
        // A failed background refresh keeps the last good billing view.
        console.error('[billing] live refresh failed', res.status);
        return;
      }
      if (!res.ok) {
        setData(null);
        setMessage(await responseErrorMessage({ status: res.status, json: async () => json }, BILLING_LOAD_FAILED));
        return;
      }
      if (!json.providers || !Array.isArray(json.catalog)) {
        setData(null);
        setMessage(BILLING_LOAD_FAILED);
        return;
      }
      setData(json);
      if (!json.providers.stripe && json.providers.razorpay) {
        setProvider('razorpay');
      }
    } catch (err) {
      console.error(err);
      if (quiet) return;
      setData(null);
      setMessage(BILLING_LOAD_FAILED);
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const checkoutResult = params.get('checkout');
    if (checkoutResult === 'success') {
      setMessage('Payment received. Your plan updates as soon as the payment is confirmed — this can take a minute.');
    } else if (checkoutResult === 'cancel') {
      setMessage('Checkout canceled — no charge was made.');
    }
    void load();
  }, []);

  useLiveRefresh({ events: BILLING_EVENTS, refetch: () => load(true) });

  const checkout = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, plan, seats }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(await responseErrorMessage({ status: res.status, json: async () => json }, 'We couldn’t start checkout. Please try again.'));
        return;
      }
      if (json.changed === true) {
        setMessage(
          json.prorated
            ? `Plan updated in place with Stripe proration (${json.plan}, ${json.seats} seats).`
            : `Plan updated in place via ${json.provider} (${json.plan}, ${json.seats} seats).`
        );
        await load();
        return;
      }
      if (typeof json.url === 'string' && json.url.length > 0) {
        window.location.href = json.url;
        return;
      }
      setMessage('Checkout did not return a payment URL. Check provider configuration.');
    } catch (err) {
      console.error(err);
      setMessage('We couldn’t start checkout. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const portal = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(await responseErrorMessage({ status: res.status, json: async () => json }, 'The billing portal isn’t available right now. Please try again.'));
        return;
      }
      if (typeof json.url === 'string' && json.url.length > 0) {
        window.location.href = json.url;
        return;
      }
      if (json.mode === 'in_app') {
        setMessage(
          json.message ||
            `Razorpay in-app manage: plan ${json.subscription?.plan ?? '—'} · ${json.subscription?.status ?? '—'}. Use Cancel or Change plan below.`
        );
        return;
      }
      setMessage('Portal did not return a manage URL. Check provider configuration.');
    } catch (err) {
      console.error(err);
      setMessage('Portal failed');
    } finally {
      setBusy(false);
    }
  };

  const cancelSubscription = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', provider, atPeriodEnd: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(await responseErrorMessage({ status: res.status, json: async () => json }, 'We couldn’t cancel that. Please try again.'));
        return;
      }
      setMessage(
        json.cancelAtPeriodEnd
          ? `Cancellation scheduled at period end (${json.provider}).`
          : `Subscription canceled (${json.provider}).`
      );
      await load();
    } catch (err) {
      console.error(err);
      setMessage('Cancel failed');
    } finally {
      setBusy(false);
    }
  };

  const changePlan = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/billing/subscription', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, plan, seats }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(await responseErrorMessage({ status: res.status, json: async () => json }, 'We couldn’t change your plan. Please try again.'));
        return;
      }
      setMessage(
        json.prorated
          ? `Upgraded to ${json.plan} with Stripe proration.`
          : `Plan changed to ${json.plan} via ${json.provider}.`
      );
      await load();
    } catch (err) {
      console.error(err);
      setMessage('Plan change failed');
    } finally {
      setBusy(false);
    }
  };

  const canManage = data?.role === 'owner' || data?.role === 'admin';
  const hasPaidSub = (data?.subscriptions ?? []).some(
    (s) => s.provider === provider && (s.status === 'active' || s.status === 'trialing')
  );
  return (
    <div className="max-w-7xl mx-auto space-y-8 pb-12">
      <div>
        <h1 className="text-3xl font-serif font-bold text-heading">Billing</h1>
        <p className="text-slate-500 text-sm mt-1">
          Your Darex subscription. Darex never holds your customers’ money.
        </p>
      </div>

      {loading ? (
        <div className="p-8 text-center text-slate-500 font-serif">Loading billing…</div>
      ) : !data ? (
        <div className="space-y-4">
          {message && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              {message}
            </div>
          )}
          <button
            type="button"
            onClick={() => void load()}
            className="px-4 py-2 border border-cream-300 font-bold text-xs rounded-2xl"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {data.usageBlocked && (
            <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <p>
                Hard usage cap reached (LLM or WhatsApp). Soft warnings appear on the meters below.
                Disconnected tools are not counted as successful actions.
              </p>
            </div>
          )}

          {data.llmError && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              We couldn’t load your AI usage cost just now, so it isn’t shown (it is not shown as $0). Your WhatsApp and seat usage are up to date.
            </div>
          )}

          {message && (
            <div className="rounded-2xl border border-cream-300 bg-cream-50 p-4 text-sm text-slate-700">
              {message}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Current plan
              </span>
              <div className="text-3xl font-bold text-heading capitalize">{data.plan}</div>
              <span className="text-xs text-slate-500 font-medium">Your current subscription</span>
            </div>
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Seats</span>
              <div className="text-3xl font-bold text-heading">{data.seatsUsed}</div>
              <span className="text-xs text-slate-500 font-medium">Members in this org</span>
            </div>
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                WhatsApp (7d)
              </span>
              <div className="text-3xl font-bold text-heading">{data.whatsappConversations}</div>
              <span className="text-xs text-slate-500 font-medium">Conversations this period</span>
            </div>
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Providers
              </span>
              <div className="text-sm font-semibold text-heading space-y-1">
                <p>Card payments (Stripe): {data.providers.stripe ? 'ready' : 'not set up yet'}</p>
                <p>UPI and cards (Razorpay): {data.providers.razorpay ? 'ready' : 'not set up yet'}</p>
                {data.providerGaps &&
                  (data.providerGaps.stripe.length > 0 || data.providerGaps.razorpay.length > 0) && (
                    <p className="text-xs font-medium text-slate-500 pt-1">
                      Your administrator still needs to finish setting up{' '}
                      {data.providerGaps.stripe.length + data.providerGaps.razorpay.length} payment{' '}
                      {data.providerGaps.stripe.length + data.providerGaps.razorpay.length === 1 ? 'setting' : 'settings'}.
                    </p>
                  )}
              </div>
            </div>
          </div>

          <div className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-4">
            <div className="flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-amber-700" />
              <h2 className="text-lg font-serif font-bold text-heading">Subscribe</h2>
            </div>
            <p className="text-sm text-slate-500">
              Org payment-link tools (Stripe/Razorpay in the agent) are separate. This checkout bills
              Darex only.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {data.catalog.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPlan(p.key)}
                  className={`text-left rounded-2xl border p-4 ${
                    plan === p.key ? 'border-amber-500 bg-amber-50' : 'border-cream-300 bg-cream-50'
                  }`}
                >
                  <div className="text-sm font-bold capitalize text-heading">{p.key}</div>
                  <div className="text-xs text-slate-500 mt-1">
                    {p.amountCents != null
                      ? formatMoney(p.amountCents, p.currency)
                      : 'Price not set yet'}
                    /period
                  </div>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                Provider
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value === 'razorpay' ? 'razorpay' : 'stripe')}
                  className="mt-1 block px-3 py-2 bg-cream-100 border border-cream-300 rounded-xl text-sm"
                >
                  <option value="stripe">Stripe</option>
                  <option value="razorpay">Razorpay</option>
                </select>
              </label>
              <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                Seats
                <input
                  type="number"
                  min={1}
                  value={seats}
                  onChange={(e) => setSeats(Math.max(1, Number(e.target.value) || 1))}
                  className="mt-1 block w-24 px-3 py-2 bg-cream-100 border border-cream-300 rounded-xl text-sm"
                />
              </label>
              <button
                type="button"
                onClick={() => void checkout()}
                disabled={busy || !canManage}
                className="px-4 py-2 bg-[#F0C05A] text-[#121917] font-bold text-xs rounded-2xl disabled:opacity-50"
              >
                {busy ? 'Working…' : hasPaidSub ? 'Change plan' : 'Start checkout'}
              </button>
              <button
                type="button"
                onClick={() => void changePlan()}
                disabled={busy || !canManage || !hasPaidSub}
                className="px-4 py-2 border border-cream-300 font-bold text-xs rounded-2xl disabled:opacity-50"
              >
                Modify in place
              </button>
              <button
                type="button"
                onClick={() => void portal()}
                disabled={busy || !canManage}
                className="px-4 py-2 border border-cream-300 font-bold text-xs rounded-2xl disabled:opacity-50"
              >
                {provider === 'razorpay' ? 'Manage (in-app)' : 'Stripe portal'}
              </button>
              <button
                type="button"
                onClick={() => void cancelSubscription()}
                disabled={busy || !canManage || !hasPaidSub}
                className="px-4 py-2 border border-red-200 text-red-800 font-bold text-xs rounded-2xl disabled:opacity-50"
              >
                Cancel at period end
              </button>
            </div>
            {!canManage && (
              <p className="text-xs text-slate-500">Only owners and admins can change billing.</p>
            )}
            {hasPaidSub && (
              <p className="text-xs text-slate-500">
                Active {provider} subscription detected — checkout modifies in place (Stripe
                prorates; Razorpay uses schedule_change_at=now).
              </p>
            )}
          </div>

          <div className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-4">
            <div className="flex items-center gap-2">
              <Gauge className="w-5 h-5 text-amber-700" />
              <h2 className="text-lg font-serif font-bold text-heading">Usage meters</h2>
            </div>
            <p className="text-sm text-slate-500">
              AI usage is the cost of your employees’ answers. WhatsApp usage counts conversations. You are warned at a soft limit and blocked at a hard limit. Actions that couldn’t run because a tool wasn’t connected don’t count as done.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {data.meters.map((m) => (
                <div key={m.kind} className="rounded-2xl border border-cream-300 bg-cream-50 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase text-slate-500">{meterLabel(m.kind)}</span>
                    {m.overHard ? (
                      <span className="text-xs font-bold text-red-700">Limit reached</span>
                    ) : m.overSoft ? (
                      <span className="text-xs font-bold text-amber-700">Nearing limit</span>
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                    )}
                  </div>
                  <div className="text-2xl font-bold text-heading mt-1">
                    {m.unit === 'usd' ? `$${m.quantity.toFixed(4)}` : m.quantity}
                    <span className="text-xs font-medium text-slate-500 ml-1">{m.unit}</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Warning at {m.softLimit ?? '—'} · stops at {m.hardLimit ?? '—'}
                    {m.truncated ? ' · partial count' : ''}
                  </p>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-slate-500">
              <span className="flex items-center gap-1">
                <Cpu className="w-3.5 h-3.5" /> AI usage
              </span>
              <span className="flex items-center gap-1">
                <MessageSquare className="w-3.5 h-3.5" /> WhatsApp
              </span>
              <span className="flex items-center gap-1">
                <Users className="w-3.5 h-3.5" /> Seats
              </span>
            </div>
          </div>

          {data.confirmReject && (
            <div className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-2">
              <h2 className="text-lg font-serif font-bold text-heading">Confirm / reject (this org)</h2>
              <p className="text-sm text-slate-500">
                An employee only moves up a level when a person approves it, and what it learns stays in your business. You will be warned if too many of its answers are rejected.
              </p>
              <p className="text-sm text-heading">
                Confirmed {data.confirmReject.confirmed} · Rejected {data.confirmReject.rejected} ·
                Pending {data.confirmReject.pending}
                {data.confirmReject.rejectRate != null
                  ? ` · reject ${(data.confirmReject.rejectRate * 100).toFixed(0)}%`
                  : ''}
                {data.confirmReject.highRejectFlag ? ' · high-reject drift' : ''}
              </p>
            </div>
          )}

          <div className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-3">
            <h2 className="text-lg font-serif font-bold text-heading">Subscription</h2>
            {data.subscriptions.length === 0 ? (
              <p className="text-sm text-slate-500">No Darex subscription yet.</p>
            ) : (
              data.subscriptions.map((s) => (
                <div key={s.id} className="flex justify-between text-sm border-b border-cream-200 py-2">
                  <span className="capitalize">
                    {s.provider} · {s.plan} · {s.status} · {s.seats} seats
                  </span>
                  <span className="text-slate-500">
                    {s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : ''}
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-3">
            <h2 className="text-lg font-serif font-bold text-heading">Invoices</h2>
            <p className="text-xs text-slate-500">
              Only your business can see these invoices.
            </p>
            {data.invoices.length === 0 ? (
              <p className="text-sm text-slate-500">No invoices for this organization.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-slate-500">
                    <th className="py-2">Date</th>
                    <th>Provider</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.invoices.map((inv) => (
                    <tr key={inv.id} className="border-t border-cream-200">
                      <td className="py-2">{new Date(inv.createdAt).toLocaleDateString()}</td>
                      <td className="capitalize">{inv.provider}</td>
                      <td>{formatMoney(inv.amountMinor, inv.currency)}</td>
                      <td>{inv.status}</td>
                      <td>
                        {inv.hostedUrl ? (
                          <a
                            href={inv.hostedUrl}
                            className="inline-flex items-center gap-1 text-amber-700 font-bold"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <p className="text-xs text-slate-400">
            First-party skill versions live on{' '}
            <Link href="/skills" className="text-amber-700 font-bold">
              /skills
            </Link>
            . There is no public marketplace.
          </p>
        </>
      )}
    </div>
  );
}
