/**
 * Ask AI @employee mention parser (E5). UX chrome is WS-19 — this module
 * only parses. Q2 decision (docs/current-working/18-q2-mention-allowlist.md):
 * mention locks the employee persona, NOT the tool allowlist. Callers must
 * keep the org-union allowlist (active employees ∪ connected channels ∪ core).
 */

export const MENTION_ALLOWLIST_MODE = 'org-union' as const;

export type MentionMode = 'auto' | 'mention';

export interface MentionableEmployee {
  id?: string;
  name: string;
  status?: string;
}

export interface EmployeeMentionLock {
  id?: string;
  name: string;
}

export interface ParseEmployeeMentionsResult {
  mode: MentionMode;
  locked: EmployeeMentionLock | null;
  remainder: string;
  rawMention: string | null;
  /** Always org-union — do not shrink tools to the locked employee. */
  allowlistMode: typeof MENTION_ALLOWLIST_MODE;
}

const ASK_TO_RE = /\bask\s+@?([A-Za-z][A-Za-z0-9._-]{1,40})\s+to\b/i;
const AT_MENTION_RE = /(?:^|\s)@([A-Za-z][A-Za-z0-9._-]{1,40})\b/;
const AUTO_RE = /^\s*@?auto\b/i;

function matchEmployee(employees: MentionableEmployee[], raw: string): MentionableEmployee | undefined {
  const needle = raw.replace(/^@/, '').trim().toLowerCase();
  if (!needle) return undefined;
  const pool = employees.filter((e) => (e.status || 'active') !== 'paused');
  const exact = pool.find((e) => e.name.toLowerCase() === needle);
  if (exact) return exact;
  return pool.find((e) => e.name.toLowerCase().startsWith(needle) && needle.length >= 3);
}

function stripMention(text: string, raw: string): string {
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`\\bask\\s+@?${escaped}\\s+to\\b`, 'ig'), '')
    .replace(new RegExp(`(?:^|\\s)@${escaped}\\b`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse @Name / “Ask Marcus to …” / explicit auto.
 * Unknown mentions do not lock; mode stays auto.
 */
export function parseEmployeeMentions(
  text: string,
  employees: MentionableEmployee[] = []
): ParseEmployeeMentionsResult {
  const input = typeof text === 'string' ? text : '';
  const base: ParseEmployeeMentionsResult = {
    mode: 'auto',
    locked: null,
    remainder: input.trim(),
    rawMention: null,
    allowlistMode: MENTION_ALLOWLIST_MODE,
  };

  if (!input.trim()) return base;
  if (AUTO_RE.test(input)) {
    return {
      ...base,
      remainder: input.replace(AUTO_RE, '').trim(),
      rawMention: 'auto',
    };
  }

  const ask = ASK_TO_RE.exec(input);
  const at = AT_MENTION_RE.exec(input);
  const raw = ask?.[1] || at?.[1];
  if (!raw) return base;

  const hit = matchEmployee(employees, raw);
  if (!hit) {
    return { ...base, rawMention: raw };
  }

  return {
    mode: 'mention',
    locked: { id: hit.id, name: hit.name },
    remainder: stripMention(input, hit.name) || input.trim(),
    rawMention: raw,
    allowlistMode: MENTION_ALLOWLIST_MODE,
  };
}
