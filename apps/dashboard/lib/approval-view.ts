/**
 * What a held action looks like to the person who has to approve it: who wants to do what, to whom, the message itself,
 * why it was held, and how long is left. One place, so the approvals page, the inbox card and the work-item board all
 * say the same thing. Pure: no network, no database.
 */

export type HeldAction = {
  id: string;
  actionType?: string | null;
  employeeRole?: string | null;
  employeeName?: string | null;
  payload?: Record<string, unknown> | null;
  requiredApprovals?: number | null;
  approvals?: Array<{ userId?: string; at?: string }> | null;
  expiresAt?: string | null;
  createdAt?: string | null;
};

export type ApprovalKind = 'email' | 'message' | 'payment' | 'refund' | 'calendar' | 'record' | 'other';

export type ApprovalView = {
  id: string;
  title: string;
  kind: ApprovalKind;
  /** Money moves: never part of an "approve all", always read first. */
  money: boolean;
  who: string;
  whyHeld: string;
  details: Array<{ label: string; value: string }>;
  /** The message text, when the action sends one, as plain text. */
  body: string | null;
  approvalsNeeded: number;
  approvalsGiven: number;
  /** "1 of 2 approvals given", only when more than one person is needed. */
  needsText: string | null;
  expiresText: string | null;
  ageText: string;
};

const MAX_BODY = 600;
const MAX_DETAILS = 6;
const BODY_KEYS = ['body', 'message', 'text', 'html', 'content'];
const SECRET_KEY = /token|secret|password|authorization|api[_-]?key|credential|signature/i;
const RECIPIENT_KEYS = ['to', 'recipient', 'phone', 'channel', 'channel_id'];
const EMAIL_FIRST = ['to', 'cc', 'bcc', 'subject'];

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

function kindOf(tool: string, action: string): ApprovalKind {
  const t = tool.toLowerCase();
  const a = action.toLowerCase();
  const both = `${t} ${a}`;
  if (/refund/.test(both)) return 'refund';
  if (/charge|payment|payout|invoice|subscription|razorpay|stripe/.test(both)) return 'payment';
  if (/calendar|event|meeting/.test(both)) return 'calendar';
  if (/gmail|email|mail|outlook/.test(both)) return 'email';
  if (/whatsapp|slack|sms|telegram|chat|message/.test(both)) return 'message';
  if (/hubspot|crm|zendesk|intercom|ticket|contact|deal|shopify/.test(both)) return 'record';
  return 'other';
}

function plainText(raw: string): string {
  return raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function bodyOf(args: Record<string, unknown>): string | null {
  for (const key of BODY_KEYS) {
    const raw = str(args[key]);
    if (!raw) continue;
    const text = key === 'html' ? plainText(raw) : raw;
    if (!text) continue;
    return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…` : text;
  }
  return null;
}

function scalarText(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function detailsOf(kind: ApprovalKind, args: Record<string, unknown>): Array<{ label: string; value: string }> {
  const keys = Object.keys(args).filter((k) => !BODY_KEYS.includes(k) && !SECRET_KEY.test(k));
  let ordered = keys;
  if (kind === 'email') ordered = [...EMAIL_FIRST.filter((k) => keys.includes(k)), ...keys.filter((k) => !EMAIL_FIRST.includes(k))];
  if (kind === 'message') {
    const first = RECIPIENT_KEYS.filter((k) => keys.includes(k)).slice(0, 1);
    ordered = [...first, ...keys.filter((k) => !first.includes(k) && !RECIPIENT_KEYS.includes(k))];
  }
  const out: Array<{ label: string; value: string }> = [];
  for (const key of ordered) {
    const value = scalarText(args[key]);
    if (!value) continue;
    out.push({ label: humanize(key), value: value.length > 200 ? `${value.slice(0, 200)}…` : value });
    if (out.length >= MAX_DETAILS) break;
  }
  return out;
}

function titleOf(stored: unknown, kind: ApprovalKind, tool: string, action: string, args: Record<string, unknown>): string {
  const summary = str(stored);
  if (summary) return summary;
  if (kind === 'email' && (str(args.to) || str(args.subject))) {
    return `Send email${str(args.subject) ? ` "${str(args.subject)}"` : ''}${str(args.to) ? ` to ${str(args.to)}` : ''}`;
  }
  if (kind === 'message' && str(args.to)) return `Send a message to ${str(args.to)}`;
  if (tool || action) return `${humanize(action || 'Run')}${tool ? ` in ${tool}` : ''}`;
  return 'An action is waiting for your OK';
}

export function reasonText(code: string | null | undefined, kind: ApprovalKind): string {
  switch (code) {
    case 'confirm_class':
      if (kind === 'refund' || kind === 'payment') return 'Moving money always needs your OK.';
      if (kind === 'email' || kind === 'message') return 'Sending a message to a customer always needs your OK.';
      return 'This kind of action always needs your OK.';
    case 'skill_tier':
      return 'This employee is not trusted to do this on their own yet.';
    case 'rollout_stage':
      return 'Your team is at a trust level where this needs your OK.';
    default:
      return 'Your workspace rules ask for your OK on this.';
  }
}

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return '';
  const secs = Math.max(0, Math.floor((now - at) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.max(1, Math.floor(secs / 60));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function expiresIn(iso: string | null | undefined, now: number = Date.now()): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const diff = at - now;
  if (diff <= 0) return 'Expired';
  const mins = Math.max(1, Math.round(diff / 60000));
  if (mins < 60) return `Expires in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Expires in ${hours} h`;
  const days = Math.round(hours / 24);
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}

export function describeHeldAction(action: HeldAction, now: number = Date.now()): ApprovalView {
  const stored = obj(action.payload);
  const tool = str(stored.tool);
  const act = str(stored.action);
  const args = obj(stored.payload);
  const kind = kindOf(tool, act);
  const needed = Math.max(1, Number(action.requiredApprovals) || 1);
  const given = Array.isArray(action.approvals) ? action.approvals.length : 0;
  return {
    id: action.id,
    title: titleOf(stored.summary, kind, tool, act, args),
    kind,
    money: kind === 'refund' || kind === 'payment',
    who: str(action.employeeName) || str(action.employeeRole) || 'An AI employee',
    whyHeld: reasonText(str(stored.reasonCode) || null, kind),
    details: detailsOf(kind, args),
    body: bodyOf(args),
    approvalsNeeded: needed,
    approvalsGiven: given,
    needsText: needed > 1 ? `${given} of ${needed} approvals given` : null,
    expiresText: expiresIn(action.expiresAt, now),
    ageText: relativeTime(action.createdAt, now),
  };
}

/** Only plain, one-person actions can be approved together; money and two-person actions are read one by one. */
export function canApproveTogether(view: ApprovalView): boolean {
  return !view.money && view.approvalsNeeded <= 1;
}
