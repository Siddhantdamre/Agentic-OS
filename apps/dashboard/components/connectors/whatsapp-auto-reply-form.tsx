'use client';

import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { networkErrorMessage } from '@/lib/client-error';

type Mode = 'agent' | 'ai_simple' | 'fixed' | 'off';
type Audience = 'everyone' | 'allow_list' | 'block_list';
type ReplyTo = 'every_message' | 'new_conversations';
type Settings = {
  mode: Mode;
  instructions: string;
  message: string;
  cooldownMinutes: number;
  fallbackTemplate: { name: string; language: string } | null;
  audience: Audience;
  numbers: string[];
  replyTo: ReplyTo;
  employeeId: string | null;
  hours: Hours;
  readMedia: boolean;
  humanPauseHours: number;
  holdingReply: { enabled: boolean; message: string };
};
type HoursMode = 'always' | 'outside_hours' | 'inside_hours';
type Hours = { mode: HoursMode; timezone: string; days: number[]; start: string; end: string };
type Employee = { id: string; name: string; role: string };

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PAUSES = [
  { hours: 0, label: 'Never pause' },
  { hours: 1, label: '1 hour' },
  { hours: 2, label: '2 hours' },
  { hours: 4, label: '4 hours' },
  { hours: 12, label: '12 hours' },
  { hours: 24, label: '24 hours' },
];

function timezones(current: string): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    /* older browser */
  }
  const browser = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return 'UTC';
    }
  })();
  return [...new Set([current, browser, 'UTC', ...all])].filter(Boolean);
}

const MODES: Array<{ id: Mode; title: string; blurb: string }> = [
  {
    id: 'agent',
    title: 'AI employee (full agent)',
    blurb: 'Your AI employees answer with your connected tools and memory, and ask for approval before risky actions.',
  },
  {
    id: 'ai_simple',
    title: 'Simple AI reply',
    blurb: 'Answers only from the business info you write below. No tools, no memory, no agent, so it cannot take actions.',
  },
  {
    id: 'fixed',
    title: 'Fixed message',
    blurb: 'Sends one message you write, at most once per customer in the time you choose.',
  },
  { id: 'off', title: 'Off', blurb: 'Messages are saved. Your team replies by hand.' },
];

const COOLDOWNS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 360, label: '6 hours' },
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: '24 hours' },
  { minutes: 10080, label: '7 days' },
];

const fieldCls = 'w-full px-4 py-2 border rounded-xl text-sm';

function Section(props: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 pt-4 border-t border-slate-100 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">{props.title}</h3>
        {props.hint && <p className="text-[11px] text-slate-400">{props.hint}</p>}
      </div>
      {props.children}
    </section>
  );
}

/** One sentence that says what will happen, so the owner can check it before saving. */
export function summarize(s: Settings, employeeName?: string): string {
  if (s.mode === 'off') return 'No automatic replies. Every message is saved for your team.';
  const who =
    s.audience === 'everyone'
      ? 'everyone'
      : s.audience === 'allow_list' && s.numbers.length === 0
        ? 'nobody yet (add numbers to your allow list)'
        : s.audience === 'allow_list'
        ? `only the ${s.numbers.length} number${s.numbers.length === 1 ? '' : 's'} on your allow list`
        : `everyone except the ${s.numbers.length} blocked number${s.numbers.length === 1 ? '' : 's'}`;
  const when = s.replyTo === 'every_message' ? 'every message' : 'the first message of each new conversation';
  const how =
    s.mode === 'agent' ? (employeeName ? `${employeeName} (your AI employee)` : 'Your AI employee') : s.mode === 'ai_simple' ? 'A simple AI' : 'A fixed message';
  const clock =
    s.hours.mode === 'always'
      ? ''
      : `, ${s.hours.mode === 'outside_hours' ? 'only when closed' : 'only when open'} (${s.hours.days.map((d) => DAY_LABELS[d]).join(', ') || 'no days'} ${s.hours.start}-${s.hours.end} ${s.hours.timezone})`;
  return `${how} will reply to ${who}, on ${when}${clock}. Other messages are still saved.`;
}

/** How the connected WhatsApp number replies. Same for the QR and official-API options. */
export default function WhatsAppAutoReplyForm(props: {
  onSaved: () => void;
  onSkip: () => void;
  skipLabel?: string;
  /** Which linked number these settings belong to; empty = the primary. */
  channelId?: string | null;
}) {
  const { onSaved, onSkip, skipLabel = 'Skip for now', channelId } = props;
  const url = `/api/integrations/whatsapp/auto-reply${channelId ? `?channelId=${encodeURIComponent(channelId)}` : ''}`;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [numbersText, setNumbersText] = useState('');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [provider, setProvider] = useState<string>('meta-cloud');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(url)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message || `HTTP ${r.status}`);
        if (alive) {
          setSettings(d.settings as Settings);
          setNumbersText(((d.settings as Settings).numbers || []).join('\n'));
          setProvider(d.provider || 'meta-cloud');
          setEmployees(Array.isArray(d.employees) ? d.employees : []);
        }
      })
      .catch((e) => alive && setLoadError(networkErrorMessage(e, 'Could not load settings')));
    return () => {
      alive = false;
    };
  }, [url]);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, numbers: numbersText }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.success) {
        setError(d.message || `HTTP ${r.status}`);
        return;
      }
      onSaved();
    } catch (e) {
      setError(networkErrorMessage(e, 'Network error'));
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <p className="text-sm text-red-600">{loadError}</p>;
  if (!settings) {
    return (
      <p className="text-sm text-slate-500 flex items-center gap-2">
        <RefreshCw className="w-4 h-4 animate-spin" /> Loading...
      </p>
    );
  }
  const set = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch });
  const listed = numbersText.split(/[\n,;]+/).filter((n) => n.trim()).length;
  const on = settings.mode !== 'off';
  const usesInstructions = settings.mode === 'agent' || settings.mode === 'ai_simple';

  return (
    <div className="space-y-4">
      <p
        role="status"
        data-testid="auto-reply-summary"
        className="text-xs rounded-xl bg-emerald-50 text-emerald-900 px-3 py-2"
      >
        {summarize({ ...settings, numbers: Array.from({ length: listed }) as string[] }, employees.find((e) => e.id === settings.employeeId)?.name)}
      </p>

      <Section title="How to reply">
        <div role="radiogroup" aria-label="Auto-reply mode" className="space-y-2">
          {MODES.map((m) => (
            <label
              key={m.id}
              className={`block p-3 border rounded-2xl cursor-pointer ${
                settings.mode === m.id ? 'border-emerald-500 bg-emerald-50/40' : 'hover:border-slate-300'
              }`}
            >
              <span className="flex items-start gap-3">
                <input
                  type="radio"
                  name="wa-auto-reply-mode"
                  checked={settings.mode === m.id}
                  onChange={() => set({ mode: m.id })}
                  className="mt-1"
                />
                <span>
                  <span className="block text-sm font-bold text-heading">{m.title}</span>
                  <span className="block text-xs text-slate-500">{m.blurb}</span>
                </span>
              </span>
            </label>
          ))}
        </div>
      </Section>

      {settings.mode === 'agent' && (
        <Section
          title="Which AI employee answers"
          hint="Used for new conversations. Automatic picks your customer or support employee first."
        >
          <select
            id="wa-ar-employee"
            aria-label="AI employee"
            value={settings.employeeId ?? ''}
            onChange={(e) => set({ employeeId: e.target.value || null })}
            className={fieldCls}
          >
            <option value="">Automatic (customer or support first)</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} · {e.role}
              </option>
            ))}
          </select>
          <label className="flex items-start gap-2 text-xs text-slate-700 pt-2">
            <input
              type="checkbox"
              checked={settings.holdingReply.enabled}
              onChange={(e) => set({ holdingReply: { ...settings.holdingReply, enabled: e.target.checked } })}
              className="mt-0.5"
            />
            <span>
              <span className="font-bold">Tell the customer to wait when the AI is not sure</span>
              <span className="block text-slate-500">
                When the AI holds its answer for your approval, the customer gets this note now instead of silence.
              </span>
            </span>
          </label>
          {settings.holdingReply.enabled && (
            <textarea
              aria-label="Waiting message"
              rows={2}
              maxLength={300}
              value={settings.holdingReply.message}
              onChange={(e) => set({ holdingReply: { ...settings.holdingReply, message: e.target.value } })}
              className={fieldCls}
            />
          )}
        </Section>
      )}

      {usesInstructions && (
        <Section
          title="Your instructions"
          hint={
            settings.mode === 'agent'
              ? 'Added to your AI employee’s guidance for every WhatsApp reply.'
              : 'The only facts it may use. If a question is not covered it says a teammate will follow up.'
          }
        >
          <textarea
            id="wa-ar-instructions"
            aria-label="Instructions"
            rows={5}
            maxLength={4000}
            value={settings.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            className={fieldCls}
            placeholder="We are open 9am to 6pm Mon-Sat. A 2BHK starts at 45 lakh. Be friendly and short. Never promise discounts."
          />
        </Section>
      )}

      {settings.mode === 'fixed' && (
        <Section title="Message">
          <textarea
            id="wa-ar-message"
            aria-label="Message to send"
            rows={3}
            maxLength={1000}
            value={settings.message}
            onChange={(e) => set({ message: e.target.value })}
            className={fieldCls}
            placeholder="Thanks for messaging us. We will get back to you shortly."
          />
          <label htmlFor="wa-ar-cooldown" className="text-xs font-bold text-slate-700">
            Send at most once every
          </label>
          <select
            id="wa-ar-cooldown"
            value={settings.cooldownMinutes}
            onChange={(e) => set({ cooldownMinutes: Number(e.target.value) })}
            className={fieldCls}
          >
            {COOLDOWNS.map((c) => (
              <option key={c.minutes} value={c.minutes}>
                {c.label}
              </option>
            ))}
          </select>
        </Section>
      )}

      {on && (
        <Section title="Who and when" hint="People who get no reply still show up in your conversations.">
          <label htmlFor="wa-ar-audience" className="text-xs font-bold text-slate-700">
            Reply to
          </label>
          <select
            id="wa-ar-audience"
            value={settings.audience}
            onChange={(e) => set({ audience: e.target.value as Audience })}
            className={fieldCls}
          >
            <option value="everyone">Everyone</option>
            <option value="allow_list">Only numbers on my allow list</option>
            <option value="block_list">Everyone except numbers on my block list</option>
          </select>
          {settings.audience !== 'everyone' && (
            <>
              <label htmlFor="wa-ar-numbers" className="text-xs font-bold text-slate-700">
                {settings.audience === 'allow_list' ? 'Allowed numbers' : 'Blocked numbers'} (one per line, with country code)
              </label>
              <textarea
                id="wa-ar-numbers"
                rows={4}
                value={numbersText}
                onChange={(e) => setNumbersText(e.target.value)}
                className={`${fieldCls} font-mono`}
                placeholder={'919812345678\n14155552671'}
              />
            </>
          )}
          <label htmlFor="wa-ar-replyto" className="text-xs font-bold text-slate-700">
            Reply on
          </label>
          <select
            id="wa-ar-replyto"
            value={settings.replyTo}
            onChange={(e) => set({ replyTo: e.target.value as ReplyTo })}
            className={fieldCls}
          >
            <option value="every_message">Every message</option>
            <option value="new_conversations">Only the first message of a new conversation</option>
          </select>

          <label htmlFor="wa-ar-hours" className="text-xs font-bold text-slate-700">
            Time of day
          </label>
          <select
            id="wa-ar-hours"
            value={settings.hours.mode}
            onChange={(e) => set({ hours: { ...settings.hours, mode: e.target.value as HoursMode } })}
            className={fieldCls}
          >
            <option value="always">Any time</option>
            <option value="outside_hours">Only outside business hours (away message)</option>
            <option value="inside_hours">Only during business hours</option>
          </select>
          {settings.hours.mode !== 'always' && (
            <div className="space-y-2 rounded-xl bg-slate-50 p-3">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Open days">
                {DAY_LABELS.map((label, d) => (
                  <label key={label} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={settings.hours.days.includes(d)}
                      onChange={(e) =>
                        set({
                          hours: {
                            ...settings.hours,
                            days: e.target.checked
                              ? [...settings.hours.days, d].sort()
                              : settings.hours.days.filter((x) => x !== d),
                          },
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-slate-600">
                  Opens
                  <input
                    type="time"
                    aria-label="Opens"
                    value={settings.hours.start}
                    onChange={(e) => set({ hours: { ...settings.hours, start: e.target.value } })}
                    className={fieldCls}
                  />
                </label>
                <label className="text-xs text-slate-600">
                  Closes
                  <input
                    type="time"
                    aria-label="Closes"
                    value={settings.hours.end}
                    onChange={(e) => set({ hours: { ...settings.hours, end: e.target.value } })}
                    className={fieldCls}
                  />
                </label>
              </div>
              <label htmlFor="wa-ar-tz" className="text-xs text-slate-600">
                Timezone
              </label>
              <select
                id="wa-ar-tz"
                value={settings.hours.timezone}
                onChange={(e) => set({ hours: { ...settings.hours, timezone: e.target.value } })}
                className={fieldCls}
              >
                {timezones(settings.hours.timezone).map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          )}

          <label htmlFor="wa-ar-pause" className="text-xs font-bold text-slate-700">
            After a teammate replies, keep the AI quiet for
          </label>
          <select
            id="wa-ar-pause"
            value={settings.humanPauseHours}
            onChange={(e) => set({ humanPauseHours: Number(e.target.value) })}
            className={fieldCls}
          >
            {PAUSES.map((p) => (
              <option key={p.hours} value={p.hours}>
                {p.label}
              </option>
            ))}
          </select>

          {usesInstructions && (
            <label className="flex items-start gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={settings.readMedia}
                onChange={(e) => set({ readMedia: e.target.checked })}
                className="mt-0.5"
              />
              <span>
                <span className="font-bold">Read voice notes and images</span>
                <span className="block text-slate-500">The AI transcribes voice notes and describes pictures before replying.</span>
              </span>
            </label>
          )}
        </Section>
      )}

      {provider === 'meta-cloud' && on && (
        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer font-bold text-slate-700">After 24 hours of silence (official API only)</summary>
          <p className="mt-2 text-slate-500">
            WhatsApp only allows an approved template once a customer has been quiet for 24 hours. Without one, replies
            after that time fail and are marked failed. Enter a template with no variables to send instead.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <input
              aria-label="Fallback template name"
              className={fieldCls}
              placeholder="template_name"
              value={settings.fallbackTemplate?.name ?? ''}
              onChange={(e) =>
                set({ fallbackTemplate: { name: e.target.value, language: settings.fallbackTemplate?.language ?? 'en' } })
              }
            />
            <input
              aria-label="Fallback template language"
              className={fieldCls}
              placeholder="en_US"
              value={settings.fallbackTemplate?.language ?? ''}
              onChange={(e) =>
                set({ fallbackTemplate: { name: settings.fallbackTemplate?.name ?? '', language: e.target.value } })
              }
            />
          </div>
        </details>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex justify-end space-x-3 pt-2">
        <button type="button" onClick={onSkip} className="px-5 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700">
          {skipLabel}
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-semibold rounded-xl flex items-center space-x-2"
        >
          {saving && <RefreshCw className="w-4 h-4 animate-spin" />}
          <span>Save</span>
        </button>
      </div>
    </div>
  );
}
