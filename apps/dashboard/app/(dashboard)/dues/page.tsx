'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, HandCoins } from 'lucide-react';
import { LiveRegion } from '@/components/a11y';
import { networkErrorMessage, responseErrorMessage } from '@/lib/client-error';
import { formatRupees } from '@/lib/dues-text';
import type { DueView, DuesSettings, DuesTotals } from '@/lib/dues-view';

interface DuesResponse {
  businessName: string;
  settings: DuesSettings;
  dues: DueView[];
  totals: DuesTotals;
}

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const SAMPLE = 'Sharma Traders\tINV-118\t120000\t12/08/2026\t30\t9876543210';

function lateLabel(d: DueView): { text: string; tone: string } {
  if (d.status === 'paid') return { text: 'Paid', tone: 'bg-emerald-50 text-emerald-800 border-emerald-200' };
  if (d.status === 'disputed') return { text: 'Disputed', tone: 'bg-amber-50 text-amber-900 border-amber-300' };
  if (d.daysLate <= 0) return { text: `Due ${fmtDay(d.dueDate)}`, tone: 'bg-slate-50 text-slate-700 border-slate-200' };
  const tone = d.daysLate > 30 ? 'bg-red-50 text-red-800 border-red-200' : 'bg-amber-50 text-amber-900 border-amber-300';
  return { text: `${d.daysLate} day${d.daysLate === 1 ? '' : 's'} late`, tone };
}

export default function DuesPage() {
  const [data, setData] = useState<DuesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState('');
  const [paste, setPaste] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [rate, setRate] = useState('');
  const [registered, setRegistered] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [language, setLanguage] = useState<'en' | 'hinglish'>('en');
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch('/api/dues');
      if (!res.ok) throw new Error(await responseErrorMessage(res, 'We couldn’t load what is owed to you. Please try again.'));
      const body = (await res.json()) as DuesResponse;
      setData(body);
      setRate(body.settings.bankRatePercent ? String(body.settings.bankRatePercent) : '');
      setRegistered(body.settings.msmeRegistered);
      setLive(body.dues.length === 0 ? 'Nothing recorded yet' : `${body.dues.length} items loaded`);
    } catch (err) {
      setLoadError(networkErrorMessage(err, 'We couldn’t load what is owed to you. Please try again.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function addList() {
    setAdding(true);
    setProblems([]);
    try {
      const res = await fetch('/api/dues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: paste }) });
      const body = (await res.json().catch(() => ({}))) as { added?: number; problems?: string[]; error?: string };
      if (!res.ok && !body.problems) throw new Error(body.error || 'We couldn’t save that list. Please try again.');
      setProblems(body.problems || []);
      if ((body.added || 0) > 0) {
        setPaste('');
        setLive(`${body.added} added`);
        await load();
      }
    } catch (err) {
      setProblems([networkErrorMessage(err, 'We couldn’t save that list. Please try again.')]);
    } finally {
      setAdding(false);
    }
  }

  async function saveSettings() {
    setSavingSettings(true);
    try {
      const res = await fetch('/api/dues/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bankRatePercent: rate.trim() === '' ? null : Number(rate), msmeRegistered: registered }),
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res, 'We couldn’t save that. Please try again.'));
      setLive('Saved');
      await load();
    } catch (err) {
      setLive(networkErrorMessage(err, 'We couldn’t save that. Please try again.'));
    } finally {
      setSavingSettings(false);
    }
  }

  async function openDraft(id: string, lang: 'en' | 'hinglish') {
    setDraftFor(id);
    setDraftBusy(true);
    setDraftError(null);
    try {
      const res = await fetch(`/api/dues/${id}/remind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preview: true, language: lang }) });
      if (!res.ok) throw new Error(await responseErrorMessage(res, 'We couldn’t write that reminder. Please try again.'));
      const body = (await res.json()) as { message: string };
      setDraft(body.message);
    } catch (err) {
      setDraftError(networkErrorMessage(err, 'We couldn’t write that reminder. Please try again.'));
    } finally {
      setDraftBusy(false);
    }
  }

  async function sendDraft(id: string) {
    setDraftBusy(true);
    setDraftError(null);
    try {
      const res = await fetch(`/api/dues/${id}/remind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: draft, language }) });
      if (!res.ok) throw new Error(await responseErrorMessage(res, 'We couldn’t prepare that reminder. Please try again.'));
      const body = (await res.json()) as { status: string };
      setLive(body.status === 'sent' ? 'Reminder sent' : 'Reminder is waiting in Approvals for your OK');
      setDraftFor(null);
      await load();
    } catch (err) {
      setDraftError(networkErrorMessage(err, 'We couldn’t prepare that reminder. Please try again.'));
    } finally {
      setDraftBusy(false);
    }
  }

  async function setStatus(id: string, status: 'paid' | 'disputed' | 'open') {
    setBusyId(id);
    try {
      const res = await fetch(`/api/dues/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
      if (!res.ok) throw new Error(await responseErrorMessage(res, 'We couldn’t update that. Please try again.'));
      setLive(status === 'paid' ? 'Marked as paid' : status === 'disputed' ? 'Marked as disputed' : 'Reopened');
      await load();
    } catch (err) {
      setLive(networkErrorMessage(err, 'We couldn’t update that. Please try again.'));
    } finally {
      setBusyId(null);
    }
  }

  const t = data?.totals;
  const noInterestYet = !data?.settings.bankRatePercent || !data?.settings.msmeRegistered;

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-20 md:pb-8">
      <LiveRegion message={live} />
      <div>
        <h1 className="text-2xl sm:text-3xl font-serif font-bold text-heading flex items-center gap-2">
          <HandCoins className="w-7 h-7 text-amber-700" aria-hidden="true" /> Money owed to you
        </h1>
        <p className="text-sm text-slate-500 mt-1">Who owes you, how late it is, and a polite way to ask. Nothing is sent until you approve it.</p>
      </div>

      {loading ? (
        <p className="p-6 text-sm text-slate-500">Loading what is owed to you…</p>
      ) : loadError ? (
        <div className="p-8 text-center space-y-3 bg-white border border-red-200 rounded-2xl">
          <AlertTriangle className="w-8 h-8 text-red-500 mx-auto" aria-hidden="true" />
          <p className="font-medium text-red-900">This page could not be loaded</p>
          <p className="text-xs text-red-700">{loadError}</p>
          <button type="button" onClick={() => { setLoading(true); void load(); }} className="rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-heading">Try again</button>
        </div>
      ) : (
        <>
          <section aria-label="Totals" className="grid gap-3 sm:grid-cols-3">
            <div className="bg-white border border-cream-300 rounded-2xl p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Owed to you</p>
              <p className="text-2xl font-bold text-heading tabular-nums">{formatRupees(t?.owed ?? 0)}</p>
              <p className="text-xs text-slate-500">{t?.openCount ?? 0} open</p>
            </div>
            <div className="bg-white border border-cream-300 rounded-2xl p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Late</p>
              <p className={`text-2xl font-bold tabular-nums ${(t?.overdue ?? 0) > 0 ? 'text-red-700' : 'text-heading'}`}>{formatRupees(t?.overdue ?? 0)}</p>
              <p className="text-xs text-slate-500">{t?.overdueCount ?? 0} past the due date</p>
            </div>
            <div className="bg-white border border-cream-300 rounded-2xl p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Interest you may claim</p>
              {noInterestYet ? (
                <p className="text-sm text-slate-600 mt-1">Tell us your bank rate below to see this.</p>
              ) : (
                <>
                  <p className="text-2xl font-bold text-heading tabular-nums">{formatRupees(t?.interest ?? 0)}</p>
                  <p className="text-xs text-slate-500">A guide to check, not legal advice</p>
                </>
              )}
            </div>
          </section>

          {problems.length > 0 && (
            <div role="alert" className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-2xl p-4 space-y-1">
              <p className="font-semibold">Some lines could not be added. The others were saved.</p>
              <ul className="list-disc pl-5 space-y-1">
                {problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
              <button type="button" onClick={() => setProblems([])} className="mt-1 rounded-lg border border-red-300 px-3 py-1 text-xs font-semibold">Dismiss</button>
            </div>
          )}

          <details className="bg-white border border-cream-300 rounded-2xl p-4" open={(data?.dues.length ?? 0) === 0 || problems.length > 0}>
            <summary className="cursor-pointer text-sm font-bold text-heading">Add what people owe you</summary>
            <div className="mt-3 space-y-3">
              <label htmlFor="dues-paste" className="block text-sm font-semibold text-heading">Paste your list</label>
              <p id="dues-hint" className="text-xs text-slate-500">
                One buyer on each line: name, invoice number, amount, invoice date, credit days, phone. You can copy it straight from a spreadsheet. For example:
              </p>
              <pre className="text-xs bg-cream-50 border border-cream-300 rounded-xl p-2 overflow-x-auto">{SAMPLE}</pre>
              <textarea
                id="dues-paste" aria-describedby="dues-hint" value={paste} onChange={(e) => setPaste(e.target.value)} rows={5}
                className="w-full rounded-xl border border-cream-300 p-3 text-sm font-mono"
              />
              <button type="button" disabled={adding || !paste.trim()} onClick={() => void addList()} className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-heading disabled:opacity-50">
                {adding ? 'Adding…' : 'Add to my list'}
              </button>
            </div>
          </details>

          <details className="bg-white border border-cream-300 rounded-2xl p-4">
            <summary className="cursor-pointer text-sm font-bold text-heading">Interest you are entitled to</summary>
            <div className="mt-3 space-y-3 text-sm">
              <p className="text-xs text-slate-500">
                A registered micro or small supplier can claim interest on a late payment: three times the RBI bank rate, added each month. Check the current rate yourself, we do not look it up. This is a guide, not legal advice.
              </p>
              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <label htmlFor="bank-rate" className="block text-xs font-semibold text-heading">RBI bank rate (%)</label>
                  <input id="bank-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} className="mt-1 w-28 rounded-xl border border-cream-300 p-2 text-sm" />
                </div>
                <label htmlFor="registered" className="flex items-center gap-2 text-sm text-heading">
                  <input id="registered" type="checkbox" checked={registered} onChange={(e) => setRegistered(e.target.checked)} />
                  My business is a registered micro or small supplier
                </label>
                <button type="button" disabled={savingSettings} onClick={() => void saveSettings()} className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-bold text-heading disabled:opacity-50">
                  {savingSettings ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </details>

          {(data?.dues.length ?? 0) === 0 ? (
            <div className="bg-white border border-dashed border-cream-300 rounded-3xl p-10 text-center space-y-2">
              <HandCoins className="w-10 h-10 text-slate-300 mx-auto" aria-hidden="true" />
              <h2 className="font-serif font-bold text-heading">Nothing recorded yet</h2>
              <p className="text-sm text-slate-500">Paste the list of people who owe you money above. We will show who is late and help you ask politely.</p>
            </div>
          ) : (
            <ul className="space-y-3" aria-label="Money owed">
              {data!.dues.map((d) => {
                const pill = lateLabel(d);
                const open = d.status !== 'paid';
                return (
                  <li key={d.id} className="bg-white border border-cream-300 rounded-2xl p-4 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-heading break-words">{d.buyerName}{d.invoiceNo ? ` · ${d.invoiceNo}` : ''}</p>
                        <p className="text-xs text-slate-500">Raised {fmtDay(d.invoiceDate)} · due {fmtDay(d.dueDate)}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold text-heading tabular-nums">{formatRupees(d.amount)}</p>
                        <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full border ${pill.tone}`}>{pill.text}</span>
                      </div>
                    </div>
                    {open && <p className="text-sm text-slate-600">{d.step.reason}</p>}
                    {open && d.interest > 0 && <p className="text-xs text-slate-500">Interest so far: {formatRupees(d.interest)}</p>}
                    {d.remindersSent > 0 && open && <p className="text-xs text-slate-500">Reminders prepared: {d.remindersSent}</p>}

                    {draftFor === d.id ? (
                      <div className="space-y-2 border-t border-cream-200 pt-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <label htmlFor={`lang-${d.id}`} className="text-xs font-semibold text-heading">Language</label>
                          <select id={`lang-${d.id}`} value={language} onChange={(e) => { const l = e.target.value as 'en' | 'hinglish'; setLanguage(l); void openDraft(d.id, l); }} className="rounded-lg border border-cream-300 p-1 text-sm">
                            <option value="en">English</option>
                            <option value="hinglish">Hindi, in English letters</option>
                          </select>
                        </div>
                        <label htmlFor={`draft-${d.id}`} className="block text-xs font-semibold text-heading">Your reminder (you can change it)</label>
                        <textarea id={`draft-${d.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} className="w-full rounded-xl border border-cream-300 p-3 text-sm" />
                        {draftError && <p role="alert" className="text-sm text-red-800">{draftError}</p>}
                        <div className="flex flex-wrap gap-2">
                          <button type="button" disabled={draftBusy || !draft.trim()} onClick={() => void sendDraft(d.id)} className="rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-heading disabled:opacity-50">
                            {draftBusy ? 'Working…' : 'Send for my approval'}
                          </button>
                          <button type="button" onClick={() => setDraftFor(null)} className="rounded-xl border border-cream-300 px-4 py-2 text-xs font-semibold text-heading">Cancel</button>
                        </div>
                        <p className="text-xs text-slate-500">It goes to <Link href="/approvals" className="font-semibold text-amber-800 underline">Approvals</Link> first. Nothing reaches {d.buyerName} until you say yes.</p>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {open && (
                          <button type="button" disabled={!d.canRemind || busyId === d.id} onClick={() => void openDraft(d.id, language)} title={d.cannotRemindBecause ?? undefined}
                            className="rounded-xl bg-amber-500 px-3 py-1.5 text-xs font-bold text-heading disabled:opacity-50">
                            Write a reminder
                          </button>
                        )}
                        {open && (
                          <button type="button" disabled={busyId === d.id} onClick={() => void setStatus(d.id, 'paid')} className="rounded-xl border border-emerald-300 px-3 py-1.5 text-xs font-semibold text-emerald-800 inline-flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> They paid
                          </button>
                        )}
                        {d.status === 'open' && (
                          <button type="button" disabled={busyId === d.id} onClick={() => void setStatus(d.id, 'disputed')} className="rounded-xl border border-cream-300 px-3 py-1.5 text-xs font-semibold text-heading">They dispute this</button>
                        )}
                        {d.status !== 'open' && (
                          <button type="button" disabled={busyId === d.id} onClick={() => void setStatus(d.id, 'open')} className="rounded-xl border border-cream-300 px-3 py-1.5 text-xs font-semibold text-heading">Reopen</button>
                        )}
                      </div>
                    )}
                    {open && !d.hasContact && d.cannotRemindBecause && draftFor !== d.id && (
                      <p className="text-xs text-slate-500">{d.cannotRemindBecause}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
