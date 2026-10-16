/**
 * Per-connection WhatsApp auto-reply settings, stored at
 * `channels.meta.auto_reply`. Same shape for the QR and official-API providers.
 *  - agent:     full AI employee (tools, memory, approvals). The default.
 *  - ai_simple: one direct model call from the business info below. No tools,
 *               no memory, no workflow.
 *  - fixed:     one canned message, at most once per cooldown per conversation.
 *  - off:       save the message, never reply.
 * Plus who gets replies (`audience` + `numbers`) and on which messages
 * (`replyTo`). Messages from people who get no reply are still saved and
 * visible to the team.
 */
export const AUTO_REPLY_MODES = ['agent', 'ai_simple', 'fixed', 'off'] as const;
export type AutoReplyMode = (typeof AUTO_REPLY_MODES)[number];

export const AUDIENCES = ['everyone', 'allow_list', 'block_list'] as const;
export type Audience = (typeof AUDIENCES)[number];
export const REPLY_TO = ['every_message', 'new_conversations'] as const;
export type ReplyTo = (typeof REPLY_TO)[number];

export const HOURS_MODES = ['always', 'outside_hours', 'inside_hours'] as const;
export type HoursMode = (typeof HOURS_MODES)[number];
export const HUMAN_PAUSE_CHOICES = [0, 1, 2, 4, 12, 24] as const;

/** Business hours: which days and the start/end time in the business's own timezone. */
export type BusinessHours = {
  /** always = any time; outside_hours = only when closed (away message); inside_hours = only when open. */
  mode: HoursMode;
  timezone: string;
  /** 0 = Sunday ... 6 = Saturday. */
  days: number[];
  start: string;
  end: string;
};

export type AutoReplyConfig = {
  mode: AutoReplyMode;
  /** agent + ai_simple: what to say and how (hours, prices, policies, tone). */
  instructions: string;
  /** fixed: the canned reply. */
  message: string;
  /** fixed: minimum minutes between auto-replies in one conversation. */
  cooldownMinutes: number;
  /**
   * Official API only: an approved template (no variables) to send when the
   * customer's 24-hour window has closed. Null = fail the send instead.
   */
  fallbackTemplate: { name: string; language: string } | null;
  /** Who gets an automatic reply. */
  audience: Audience;
  /** allow_list: only these numbers. block_list: everyone except these. Digits with country code. */
  numbers: string[];
  /** Reply to every message, or only the first message of a new conversation. */
  replyTo: ReplyTo;
  /** Agent mode: which AI employee answers new conversations. Null = automatic (customer/support first). */
  employeeId: string | null;
  /** When automatic replies are sent, by the clock. */
  hours: BusinessHours;
  /** Agent and simple AI: read voice notes and images before replying. */
  readMedia: boolean;
  /** Hours the AI stays quiet in a conversation after a teammate replies (0 = never pause). */
  humanPauseHours: number;
  /**
   * Agent mode: when the AI is not sure and waits for the owner, tell the
   * customer a teammate will follow up (otherwise they hear nothing until approval).
   */
  holdingReply: { enabled: boolean; message: string };
};

export const DEFAULT_AUTO_REPLY: AutoReplyConfig = {
  mode: 'agent',
  instructions: '',
  message: '',
  cooldownMinutes: 720,
  fallbackTemplate: null,
  audience: 'everyone',
  numbers: [],
  replyTo: 'every_message',
  employeeId: null,
  hours: { mode: 'always', timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  readMedia: true,
  humanPauseHours: 2,
  holdingReply: { enabled: false, message: 'Thanks for your message. A teammate is checking and will reply shortly.' },
};

const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANG = /^[a-z]{2,3}(_[A-Z]{2})?$/;

function parseTemplate(raw: unknown): AutoReplyConfig['fallbackTemplate'] {
  const t = (raw && typeof raw === 'object' ? raw : null) as { name?: unknown; language?: unknown } | null;
  return t && typeof t.name === 'string' && typeof t.language === 'string' && TEMPLATE_NAME.test(t.name) && TEMPLATE_LANG.test(t.language)
    ? { name: t.name, language: t.language }
    : null;
}

export const AUTO_REPLY_LIMITS = {
  holdingMessage: 300, instructions: 4000, message: 1000, cooldownMin: 1, cooldownMax: 10080, numbers: 200 };

function isMode(v: unknown): v is AutoReplyMode {
  return typeof v === 'string' && (AUTO_REPLY_MODES as readonly string[]).includes(v);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseHours(raw: unknown): BusinessHours {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_AUTO_REPLY.hours;
  const days = Array.isArray(r.days) ? r.days.filter((x): x is number => Number.isInteger(x) && x >= 0 && x <= 6) : d.days;
  return {
    mode: typeof r.mode === 'string' && (HOURS_MODES as readonly string[]).includes(r.mode) ? (r.mode as HoursMode) : d.mode,
    timezone: validTimezone(r.timezone) ? r.timezone : d.timezone,
    days: [...new Set(days)].sort(),
    start: typeof r.start === 'string' && HHMM.test(r.start) ? r.start : d.start,
    end: typeof r.end === 'string' && HHMM.test(r.end) && (r.start as string) < r.end ? r.end : d.end,
  };
}

/** Is `now` inside the business hours (open)? Pure given `now`. */
export function isWithinBusinessHours(h: BusinessHours, now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: h.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const hhmm = `${get('hour')}:${get('minute')}`;
  return h.days.includes(day) && hhmm >= h.start && hhmm < h.end;
}

function parseHolding(raw: unknown): AutoReplyConfig['holdingReply'] {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_AUTO_REPLY.holdingReply;
  const msg = typeof r.message === 'string' ? r.message.trim().slice(0, AUTO_REPLY_LIMITS.holdingMessage) : '';
  return { enabled: r.enabled === true, message: msg || d.message };
}

function isAudience(v: unknown): v is Audience {
  return typeof v === 'string' && (AUDIENCES as readonly string[]).includes(v);
}
function isReplyTo(v: unknown): v is ReplyTo {
  return typeof v === 'string' && (REPLY_TO as readonly string[]).includes(v);
}

/** "+91 98123-45678, 4479…" or an array -> unique digit strings of 7 to 15 digits. Null if any entry is not a number. */
export function normalizeNumbers(input: unknown): string[] | null {
  const raw = Array.isArray(input) ? input.map(String) : typeof input === 'string' ? input.split(/[\n,;]+/) : [];
  const out = new Set<string>();
  for (const item of raw) {
    const t = item.trim();
    if (!t) continue;
    const digits = t.replace(/[\s()+-]/g, '');
    if (!/^\d{7,15}$/.test(digits)) return null;
    out.add(digits);
  }
  return [...out];
}

/** Same person if equal, or one is the other without its country code (10+ digits shared). */
function sameNumber(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 10 && long.endsWith(short);
}

/**
 * Decide whether this contact gets an automatic reply. A contact whose number
 * is unknown (an unresolved WhatsApp id) is never on an allow list and never
 * caught by a block list. Pure.
 */
export function shouldAutoReply(
  cfg: AutoReplyConfig,
  contact: string,
  isNewConversation: boolean,
  now: Date = new Date()
): { reply: true } | { reply: false; reason: string } {
  if (cfg.mode === 'off') return { reply: false, reason: 'auto-reply is off' };
  if (cfg.hours.mode !== 'always') {
    const open = isWithinBusinessHours(cfg.hours, now);
    if (cfg.hours.mode === 'outside_hours' && open) return { reply: false, reason: 'business hours: team is open' };
    if (cfg.hours.mode === 'inside_hours' && !open) return { reply: false, reason: 'business hours: team is closed' };
  }
  const digits = contact.includes('@') ? null : contact.replace(/\D/g, '');
  const listed = digits ? cfg.numbers.some((n) => sameNumber(n, digits)) : false;
  if (cfg.audience === 'allow_list' && !listed) return { reply: false, reason: 'number is not on the allow list' };
  if (cfg.audience === 'block_list' && listed) return { reply: false, reason: 'number is blocked' };
  if (cfg.replyTo === 'new_conversations' && !isNewConversation) {
    return { reply: false, reason: 'only new conversations get an automatic reply' };
  }
  return { reply: true };
}

/** Owner instructions ride along with the AI employee's persona in agent mode. */
export function personaWithInstructions(persona: string, cfg: AutoReplyConfig): string {
  if (cfg.mode !== 'agent' || !cfg.instructions.trim()) return persona;
  return `${persona}\n\nThe business owner's instructions for WhatsApp replies (follow them):\n${cfg.instructions.trim()}`;
}

/** Tolerant read of stored meta: anything malformed falls back to the default (agent). */
export function parseAutoReply(raw: unknown): AutoReplyConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!isMode(r.mode)) return { ...DEFAULT_AUTO_REPLY };
  const cooldown = Number(r.cooldownMinutes);
  return {
    mode: r.mode,
    instructions: typeof r.instructions === 'string' ? r.instructions.slice(0, AUTO_REPLY_LIMITS.instructions) : '',
    message: typeof r.message === 'string' ? r.message.slice(0, AUTO_REPLY_LIMITS.message) : '',
    cooldownMinutes:
      Number.isInteger(cooldown) && cooldown >= AUTO_REPLY_LIMITS.cooldownMin && cooldown <= AUTO_REPLY_LIMITS.cooldownMax
        ? cooldown
        : DEFAULT_AUTO_REPLY.cooldownMinutes,
    fallbackTemplate: parseTemplate(r.fallbackTemplate),
    audience: isAudience(r.audience) ? r.audience : DEFAULT_AUTO_REPLY.audience,
    numbers: normalizeNumbers(r.numbers)?.slice(0, AUTO_REPLY_LIMITS.numbers) ?? [],
    replyTo: isReplyTo(r.replyTo) ? r.replyTo : DEFAULT_AUTO_REPLY.replyTo,
    employeeId: typeof r.employeeId === 'string' && UUID.test(r.employeeId) ? r.employeeId.toLowerCase() : null,
    hours: parseHours(r.hours),
    readMedia: r.readMedia === false ? false : true,
    humanPauseHours:
      typeof r.humanPauseHours === 'number' && (HUMAN_PAUSE_CHOICES as readonly number[]).includes(r.humanPauseHours)
        ? r.humanPauseHours
        : DEFAULT_AUTO_REPLY.humanPauseHours,
    holdingReply: parseHolding(r.holdingReply),
  };
}

/** Strict check for what the settings API accepts. */
export function validateAutoReply(
  body: unknown
): { ok: true; value: AutoReplyConfig } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (!isMode(b.mode)) return { ok: false, error: `mode must be one of: ${AUTO_REPLY_MODES.join(', ')}` };
  const instructions = b.instructions == null ? '' : b.instructions;
  const message = b.message == null ? '' : b.message;
  if (typeof instructions !== 'string' || instructions.length > AUTO_REPLY_LIMITS.instructions) {
    return { ok: false, error: `instructions must be text up to ${AUTO_REPLY_LIMITS.instructions} characters` };
  }
  if (typeof message !== 'string' || message.length > AUTO_REPLY_LIMITS.message) {
    return { ok: false, error: `message must be text up to ${AUTO_REPLY_LIMITS.message} characters` };
  }
  if (b.mode === 'fixed' && !message.trim()) {
    return { ok: false, error: 'Write the message to send when the mode is fixed reply' };
  }
  const cooldown = b.cooldownMinutes == null ? DEFAULT_AUTO_REPLY.cooldownMinutes : Number(b.cooldownMinutes);
  if (!Number.isInteger(cooldown) || cooldown < AUTO_REPLY_LIMITS.cooldownMin || cooldown > AUTO_REPLY_LIMITS.cooldownMax) {
    return {
      ok: false,
      error: `cooldownMinutes must be a whole number from ${AUTO_REPLY_LIMITS.cooldownMin} to ${AUTO_REPLY_LIMITS.cooldownMax}`,
    };
  }
  let fallbackTemplate: AutoReplyConfig['fallbackTemplate'] = null;
  if (b.fallbackTemplate != null && !(typeof b.fallbackTemplate === 'object' && !(b.fallbackTemplate as any).name)) {
    fallbackTemplate = parseTemplate(b.fallbackTemplate);
    if (!fallbackTemplate) {
      return {
        ok: false,
        error: 'Template name must be lowercase letters, numbers and underscores; language like en or en_US',
      };
    }
  }
  const audience = b.audience == null ? DEFAULT_AUTO_REPLY.audience : b.audience;
  if (!isAudience(audience)) return { ok: false, error: `audience must be one of: ${AUDIENCES.join(', ')}` };
  const replyTo = b.replyTo == null ? DEFAULT_AUTO_REPLY.replyTo : b.replyTo;
  if (!isReplyTo(replyTo)) return { ok: false, error: `replyTo must be one of: ${REPLY_TO.join(', ')}` };
  const rawEmployee = b.employeeId == null || b.employeeId === '' || b.employeeId === 'auto' ? null : b.employeeId;
  if (rawEmployee !== null && !(typeof rawEmployee === 'string' && UUID.test(rawEmployee))) {
    return { ok: false, error: 'employeeId must be an AI employee id, or empty for automatic' };
  }
  const h = (b.hours == null ? DEFAULT_AUTO_REPLY.hours : b.hours) as Record<string, unknown>;
  const hoursMode = h.mode ?? 'always';
  if (typeof hoursMode !== 'string' || !(HOURS_MODES as readonly string[]).includes(hoursMode)) {
    return { ok: false, error: `hours.mode must be one of: ${HOURS_MODES.join(', ')}` };
  }
  let hours: BusinessHours = { ...DEFAULT_AUTO_REPLY.hours, mode: hoursMode as HoursMode };
  if (hoursMode !== 'always') {
    if (!validTimezone(h.timezone)) return { ok: false, error: 'Choose a valid timezone for the business hours' };
    if (!Array.isArray(h.days) || h.days.length === 0 || !h.days.every((x) => Number.isInteger(x) && x >= 0 && x <= 6)) {
      return { ok: false, error: 'Pick at least one open day' };
    }
    if (typeof h.start !== 'string' || typeof h.end !== 'string' || !HHMM.test(h.start) || !HHMM.test(h.end) || h.start >= h.end) {
      return { ok: false, error: 'Opening time must be before closing time (HH:MM)' };
    }
    hours = { mode: hoursMode as HoursMode, timezone: h.timezone, days: [...new Set(h.days as number[])].sort(), start: h.start, end: h.end };
  } else if (validTimezone(h.timezone)) {
    hours.timezone = h.timezone;
  }
  const pause = b.humanPauseHours == null ? DEFAULT_AUTO_REPLY.humanPauseHours : Number(b.humanPauseHours);
  if (!(HUMAN_PAUSE_CHOICES as readonly number[]).includes(pause)) {
    return { ok: false, error: `humanPauseHours must be one of: ${HUMAN_PAUSE_CHOICES.join(', ')}` };
  }
  if (b.readMedia != null && typeof b.readMedia !== 'boolean') return { ok: false, error: 'readMedia must be true or false' };
  const hr = (b.holdingReply == null ? {} : b.holdingReply) as Record<string, unknown>;
  if (typeof hr !== 'object' || (hr.enabled != null && typeof hr.enabled !== 'boolean')) {
    return { ok: false, error: 'holdingReply.enabled must be true or false' };
  }
  if (hr.message != null && (typeof hr.message !== 'string' || hr.message.length > AUTO_REPLY_LIMITS.holdingMessage)) {
    return { ok: false, error: `The waiting message must be text up to ${AUTO_REPLY_LIMITS.holdingMessage} characters` };
  }
  const holdingReply = parseHolding({ enabled: hr.enabled === true, message: hr.message });
  const numbers = normalizeNumbers(b.numbers ?? []);
  if (!numbers) return { ok: false, error: 'Numbers must be phone numbers with country code, like 919812345678' };
  if (numbers.length > AUTO_REPLY_LIMITS.numbers) {
    return { ok: false, error: `At most ${AUTO_REPLY_LIMITS.numbers} numbers` };
  }
  if (audience === 'allow_list' && numbers.length === 0) {
    return { ok: false, error: 'Add at least one number, or nobody will get a reply' };
  }
  return {
    ok: true,
    value: {
      mode: b.mode,
      instructions: instructions.trim(),
      message: message.trim(),
      cooldownMinutes: cooldown,
      fallbackTemplate,
      audience,
      numbers,
      replyTo,
      employeeId: rawEmployee ? (rawEmployee as string).toLowerCase() : null,
      hours,
      readMedia: b.readMedia === false ? false : true,
      humanPauseHours: pause,
      holdingReply,
    },
  };
}
