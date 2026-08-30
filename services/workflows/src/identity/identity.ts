/**
 * WHO IS THIS, ACROSS EVERY CHANNEL.
 *
 * Measured before this file existed: 710 conversations, 710 distinct contacts.
 * `conversations.contact_id` is a raw TEXT handle — a phone number as the
 * channel happened to spell it — copied onto every row. So the same person is
 * a different stranger every time they write, and:
 *
 *   the agent re-asks what it was told last week
 *   "have we spoken before" is unanswerable
 *   a follow-up counts one person as several quiet leads
 *   an erasure request cannot be honoured, because you cannot erase somebody
 *     you cannot identify
 *
 * ── THE FAILURE MODES ARE NOT SYMMETRIC ───────────────────────────────────
 *
 * UNDER-merging costs context. The agent forgets, asks again, looks stupid.
 * Annoying, recoverable, invisible to anyone but the customer's patience.
 *
 * OVER-merging shows one customer another customer's history. Their budget,
 * their address, their complaint. That is a privacy breach with a person's
 * name on it, it cannot be undone, and it is the single worst thing this
 * system could do.
 *
 * So every rule here refuses to merge unless it is certain, and every
 * ambiguous case stays two people. A conservative matcher that occasionally
 * forgets is a product problem. An eager one is an incident.
 *
 * ── WHY NOT FUZZY MATCHING ────────────────────────────────────────────────
 *
 * No name similarity, no "same surname and city", no edit distance. Those find
 * more matches and each one is a coin flip on the paragraph above. Identity is
 * joined ONLY on an identifier the person themselves used: a phone number they
 * messaged from, an email they wrote from. Two handles are the same person
 * when they normalise to the same string, and never otherwise.
 */

export type IdentityKind = 'phone' | 'email' | 'handle';

export interface NormalisedIdentity {
  kind: IdentityKind;
  /** The canonical form two handles must share to be one person. */
  value: string;
  /** Exactly as the channel gave it, kept for display and for audit. */
  raw: string;
  /**
   * False when the input could not be canonicalised confidently. Such a handle
   * still becomes an identity — it is how that channel refers to them — but it
   * only ever matches itself, byte for byte.
   */
  confident: boolean;
}

/**
 * India's default country code.
 *
 * A bare ten-digit number is the overwhelmingly common way an Indian phone is
 * written, and it has no country code to read. Assuming one is unavoidable;
 * assuming the WRONG one silently merges two people in different countries, so
 * it is configurable rather than hard-coded, and only applied to lengths that
 * are unambiguous.
 */
const DEFAULT_CC = process.env.DAREX_DEFAULT_COUNTRY_CODE || '91';

/**
 * What a channel writes when it does not know who somebody is.
 *
 * Never an identity. If "unknown" were treated as one, every anonymous sender
 * in a workspace would collapse into a single person holding all of their
 * conversations -- one customer reading another's budget, address and
 * complaints.
 */
const PLACEHOLDER_HANDLES = new Set([
  'unknown', 'anonymous', 'anon', 'guest', 'user', 'customer', 'contact',
  'none', 'null', 'nil', 'n/a', 'na', 'no-reply', 'noreply', 'test',
  '-', '--', '?', 'undefined', 'unassigned',
]);

/** Indian mobile numbers start 6-9. Landlines and shortcodes do not. */
const IN_MOBILE_FIRST_DIGIT = /^[6-9]/;

function digitsOnly(s: string): string {
  return String(s).replace(/[^0-9]/g, '');
}

/**
 * Phone → a canonical string, or `confident: false`.
 *
 * Handles the ways one Indian mobile is actually written:
 *
 *   +91 97999 92973 · 919799992973 · 09799992973 · 9799992973 · (+91)-9799992973
 *
 * and refuses anything it cannot place, rather than guessing. A five-digit
 * shortcode is not a person; two different businesses' shortcodes normalising
 * together would merge every customer who ever contacted either.
 */
export function normalisePhone(raw: string): NormalisedIdentity {
  const original = String(raw ?? '').trim();
  const hadPlus = original.trimStart().startsWith('+');
  let d = digitsOnly(original);

  // 00 as the international prefix, the other way of writing +.
  if (!hadPlus && d.startsWith('00')) d = d.slice(2);

  const unconfident: NormalisedIdentity = {
    kind: 'phone',
    // Falls back to the raw string lower-cased, so it still matches itself
    // exactly and nothing else.
    value: `raw:${original.toLowerCase()}`,
    raw: original,
    confident: false,
  };

  if (!d) return unconfident;

  // A national trunk prefix. 0 then a ten-digit mobile.
  if (d.length === 11 && d.startsWith('0') && IN_MOBILE_FIRST_DIGIT.test(d.slice(1))) {
    d = d.slice(1);
  }

  // Bare national mobile.
  if (d.length === 10 && IN_MOBILE_FIRST_DIGIT.test(d)) {
    return { kind: 'phone', value: `${DEFAULT_CC}${d}`, raw: original, confident: true };
  }

  // Already carries the country code.
  if (d.length === 12 && d.startsWith(DEFAULT_CC) && IN_MOBILE_FIRST_DIGIT.test(d.slice(2))) {
    return { kind: 'phone', value: d, raw: original, confident: true };
  }

  // A foreign number written with + or 00. Kept whole: there is no safe way to
  // canonicalise an arbitrary country's national format, so it matches only an
  // identical rendering. That under-merges, which is the direction to fail in.
  if (hadPlus || String(raw ?? '').trim().startsWith('00')) {
    if (d.length >= 8 && d.length <= 15) {
      return { kind: 'phone', value: d, raw: original, confident: true };
    }
  }

  // Everything else — shortcodes, landlines without an area code, truncated
  // numbers, anything of an unexpected length. Never merged.
  return unconfident;
}

/**
 * Email → a canonical string.
 *
 * Case-insensitive, because the local part is case-insensitive at every real
 * provider despite the RFC permitting otherwise.
 *
 * Gmail dots and +tags are deliberately NOT stripped. It is true that
 * r.a.j+flats@gmail.com reaches the same inbox as raj@gmail.com, and it is
 * ALSO true that the same trick is not universal, that plenty of providers
 * treat dots as significant, and that merging on a provider-specific rule
 * means one wrong guess joins two strangers. The gain is a handful of extra
 * matches; the loss is the paragraph at the top of this file.
 */
export function normaliseEmail(raw: string): NormalisedIdentity {
  const original = String(raw ?? '').trim();
  const lower = original.toLowerCase();
  const at = lower.indexOf('@');
  const looksLikeEmail =
    at > 0 && at < lower.length - 1 && !/\s/.test(lower) && lower.slice(at + 1).includes('.');

  if (!looksLikeEmail) {
    return { kind: 'email', value: `raw:${lower}`, raw: original, confident: false };
  }
  return { kind: 'email', value: lower, raw: original, confident: true };
}

/**
 * Any handle from any channel.
 *
 * The channel is a hint, not an instruction: a WhatsApp conversation whose
 * handle is an email address is an email address, whatever the column says.
 */
export function normaliseIdentity(raw: string, channelHint?: string): NormalisedIdentity {
  const s = String(raw ?? '').trim();
  if (!s) return { kind: 'handle', value: '', raw: s, confident: false };

  if (s.includes('@') && !/^[(+0-9][0-9 ()+-]*$/.test(s)) return normaliseEmail(s);
  // Leading '(' included: "(+91)-97999-92973" is a phone number, and the
  // first version classified it as a USERNAME because the character class
  // started at '+'. It became its own person rather than joining the four
  // other spellings of the same human.
  if (/^[(+0-9][0-9 ()+.\-]*$/.test(s)) return normalisePhone(s);

  const hint = String(channelHint || '').toLowerCase();
  if (hint.includes('mail')) return normaliseEmail(s);
  if (hint.includes('whatsapp') || hint.includes('sms') || hint.includes('phone')) {
    return normalisePhone(s);
  }

  // A platform username. Case-insensitive, otherwise untouched -- unless it is
  // a placeholder, which is the most dangerous input this function receives.
  //
  // Channels write "unknown", "anonymous", "guest" or "-" when they do not
  // know who sent something. Treating that as an identity merges EVERY
  // unidentified sender in the workspace into one person, who then sees all of
  // their histories. That is the exact catastrophe the top of this file is
  // written to prevent, and the first version of this line caused it: a test
  // asserting that an unparseable handle matches nothing failed on "unknown".
  const lower = s.toLowerCase();
  if (PLACEHOLDER_HANDLES.has(lower) || lower.length < 3) {
    return { kind: 'handle', value: `raw:${lower}`, raw: s, confident: false };
  }
  return { kind: 'handle', value: lower, raw: s, confident: true };
}

/**
 * Are these two handles the same person?
 *
 * Only when both normalise confidently to the same value. Two unconfident
 * handles are never merged even if their raw strings match, because the reason
 * they are unconfident is that nobody knows what they are — and "two things I
 * could not parse look alike" is not evidence about a human being.
 */
export function isSamePerson(a: string, b: string, channelHint?: string): boolean {
  const x = normaliseIdentity(a, channelHint);
  const y = normaliseIdentity(b, channelHint);
  if (!x.confident || !y.confident) return false;
  if (!x.value || !y.value) return false;
  return x.kind === y.kind && x.value === y.value;
}

/**
 * Group raw handles into people.
 *
 * Returns one bucket per distinct person, each holding every raw spelling seen.
 * Unconfident handles each get their own bucket — they are somebody, they are
 * just not knowably the same somebody as anyone else.
 */
export function groupIntoPeople(handles: string[], channelHint?: string): Array<{
  value: string;
  kind: IdentityKind;
  confident: boolean;
  raws: string[];
}> {
  const byKey = new Map<string, { value: string; kind: IdentityKind; confident: boolean; raws: string[] }>();
  let unconfidentSeq = 0;

  for (const h of handles) {
    const n = normaliseIdentity(h, channelHint);
    // Unique key per unconfident handle: never collapsed with anything.
    const key = n.confident ? `${n.kind}:${n.value}` : `unconfident:${unconfidentSeq++}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.raws.includes(n.raw)) existing.raws.push(n.raw);
    } else {
      byKey.set(key, { value: n.value, kind: n.kind, confident: n.confident, raws: [n.raw] });
    }
  }
  return [...byKey.values()];
}
