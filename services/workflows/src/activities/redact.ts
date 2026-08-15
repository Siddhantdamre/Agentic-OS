import type { DataClass } from '@darex/shared-types';
import { DATA_CLASSES } from '@darex/shared-types';

export type RedactSkipReason = 'kyc' | 'empty';

export type RedactPatternName =
  | 'api_key'
  | 'bearer_token'
  | 'aws_access_key'
  | 'github_token'
  | 'slack_token'
  | 'private_key'
  | 'pan'
  | 'aadhaar'
  | 'ssn'
  | 'card_pan';

export interface RedactForEmbedOptions {
  kind?: string | null;
  dataClass?: string | null;
}

export interface RedactForEmbedResult {
  text: string;
  skipped: boolean;
  reason: RedactSkipReason | null;
  stripped: RedactPatternName[];
}

const REDACTED = '[REDACTED]';

const KYC_KINDS = new Set(['kyc', 'pan', 'aadhaar', 'passport', 'gov_id', 'government_id']);

const STRIP_PATTERNS: ReadonlyArray<{ name: RedactPatternName; regex: RegExp }> = [
  { name: 'private_key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'api_key', regex: /\bsk-(?:or-|ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g },
  { name: 'api_key', regex: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,}/gi },
  { name: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9._\-+=/]{12,}/gi },
  { name: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github_token', regex: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: 'slack_token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'pan', regex: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  // card_pan (16 digits) must run before aadhaar (12 digits): the aadhaar
  // regex otherwise greedily matches the first 12 digits of a 16-digit card
  // number and leaves the last 4 digits (plus a separator) unredacted.
  { name: 'card_pan', regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g },
  { name: 'aadhaar', regex: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g },
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
];

function parseDataClass(value: string | null | undefined): DataClass | undefined {
  if (!value) return undefined;
  for (const item of DATA_CLASSES) {
    if (item === value) return item;
  }
  return undefined;
}

function isKycKind(kind: string | null | undefined): boolean {
  if (!kind) return false;
  return KYC_KINDS.has(kind.trim().toLowerCase());
}

function shouldSkipKyc(opts: RedactForEmbedOptions | undefined): boolean {
  if (isKycKind(opts?.kind)) return true;
  const dataClass = parseDataClass(opts?.dataClass);
  if (!dataClass) return false;
  switch (dataClass) {
    case 'kyc_pointer':
      return true;
    case 'public':
    case 'internal':
    case 'pii':
    case 'financial':
    case 'health_pointer':
    case 'child_related':
      return false;
    default: {
      const _exhaustive: never = dataClass;
      return _exhaustive;
    }
  }
}

/**
 * Strip secrets and government-id / card PAN patterns. Never returns the
 * original string when a match fired. KYC kinds / kyc_pointer are not
 * embeddable — callers must skip LiteLLM and must not persist PAN.
 */
export function redactForEmbed(raw: string, opts?: RedactForEmbedOptions): RedactForEmbedResult {
  const stripped: RedactPatternName[] = [];
  let text = typeof raw === 'string' ? raw : '';

  for (const pattern of STRIP_PATTERNS) {
    const next = text.replace(pattern.regex, () => {
      if (!stripped.includes(pattern.name)) stripped.push(pattern.name);
      return REDACTED;
    });
    text = next;
  }

  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  if (shouldSkipKyc(opts)) {
    return { text: '', skipped: true, reason: 'kyc', stripped };
  }
  if (!text) {
    return { text: '', skipped: true, reason: 'empty', stripped };
  }
  return { text, skipped: false, reason: null, stripped };
}

/** Activity wrapper — Temporal registers this; tests call `redactForEmbed` directly. */
export async function redactForEmbedActivity(input: {
  text: string;
  kind?: string | null;
  dataClass?: string | null;
}): Promise<RedactForEmbedResult> {
  return redactForEmbed(input.text, { kind: input.kind, dataClass: input.dataClass });
}

/** Sanitize activity/job error strings so secrets never land in `ingestion_jobs.error`. */
export function redactErrorMessage(message: string, maxLen = 500): string {
  const cleaned = redactForEmbed(message).text || 'embed failed';
  return cleaned.slice(0, maxLen);
}
