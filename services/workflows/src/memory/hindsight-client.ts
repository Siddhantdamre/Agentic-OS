/**
 * Hindsight memory client (vectorize-io/hindsight REST API).
 *
 * One bank per org (`org_<uuid>`, auto-created on first retain). Recall runs
 * semantic + BM25 + graph + temporal in parallel server-side; retain extracts
 * facts/entities from raw text. Runs beside Cognee, both feed the `graph` tier.
 */

import type { MemoryCitation } from '@darex/shared-types';
import { redactForEmbed } from '../activities/redact.js';

const rawUrl = process.env.HINDSIGHT_URL || '';
const HINDSIGHT_URL = (
  rawUrl && !rawUrl.includes('host.docker.internal')
    ? rawUrl
    : process.env.DB_HOST === 'pgbouncer'
      ? 'http://hindsight:8888'
      : rawUrl || 'http://127.0.0.1:8888'
).replace(/\/$/, '');
const HINDSIGHT_TIMEOUT_MS = parseInt(process.env.HINDSIGHT_TIMEOUT_MS || '3500', 10);

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  const key = process.env.HINDSIGHT_API_KEY?.trim();
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

export function hindsightBank(orgId: string): string {
  return `org_${orgId}`;
}

async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${HINDSIGHT_URL}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function isHindsightHealthy(timeoutMs = 800): Promise<boolean> {
  try {
    const res = await call('/health', { method: 'GET', headers: headers() }, timeoutMs);
    return res.ok;
  } catch {
    return false;
  }
}

export interface HindsightSearchParams {
  orgId: string;
  query: string;
  topK?: number;
  timeoutMs?: number;
}

/** Recall facts for an org. Throws on failure so callers never mistake an outage for an empty bank. */
export async function searchHindsight(params: HindsightSearchParams): Promise<MemoryCitation[]> {
  const { orgId, query } = params;
  if (!orgId || !query?.trim()) return [];
  const topK = params.topK ?? 8;
  const bank = hindsightBank(orgId);

  const res = await call(
    `/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`,
    {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ query: query.trim(), budget: 'low', max_tokens: 2048 }),
    },
    params.timeoutMs ?? HINDSIGHT_TIMEOUT_MS,
  );
  if (!res.ok) {
    // Bank not created yet = new tenant with nothing retained.
    if (res.status === 404) return [];
    const detail = await res.text().catch(() => '');
    throw new Error(`Hindsight recall failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 160)}` : ''}`);
  }

  const data = (await res.json()) as {
    results?: Array<{ text?: string; mentioned_at?: string | null; occurred_start?: string | null }>;
  };
  const citations: MemoryCitation[] = [];
  for (const r of data.results ?? []) {
    const snippet = (r.text || '').trim();
    if (!snippet) continue;
    citations.push({
      id: `G-${citations.length + 1}`,
      tier: 'graph',
      snippet,
      source: 'graph',
      sourceRef: `hindsight:${bank}`,
      stale: false,
      updatedAt: r.mentioned_at || r.occurred_start || '',
    });
    if (citations.length >= topK) break;
  }
  return citations;
}

export interface HindsightRetainParams {
  orgId: string;
  text: string;
  /** Same id = upsert, so a growing conversation replaces its earlier retain. */
  documentId?: string;
  context?: string;
  timeoutMs?: number;
}

// Banks are auto-created with default missions, which extract noise. Set ours
// once per org per process, before the first retain; a failure retries next time.
const RETAIN_MISSION =
  'Extract customer and lead preferences, budgets, deadlines, commitments, decisions, objections and open questions from business conversations. Ignore greetings, small talk and scheduling filler.';
const OBSERVATIONS_MISSION =
  'Identify durable customer preferences, recurring patterns and changes in stated needs. Flag when a customer contradicts something said earlier.';
const configuredBanks = new Set<string>();

async function ensureBank(orgId: string): Promise<void> {
  if (configuredBanks.has(orgId)) return;
  try {
    const res = await call(
      `/v1/default/banks/${encodeURIComponent(hindsightBank(orgId))}/config`,
      {
        method: 'PATCH',
        headers: headers(true),
        body: JSON.stringify({ updates: { retain_mission: RETAIN_MISSION, observations_mission: OBSERVATIONS_MISSION } }),
      },
      HINDSIGHT_TIMEOUT_MS * 2,
    );
    if (res.ok) configuredBanks.add(orgId);
  } catch {
    // best-effort: retain proceeds on default missions
  }
}

/** Queue a retain (async on the server: extraction happens after the 202-style ack). */
export async function retainHindsight(params: HindsightRetainParams): Promise<boolean> {
  const { orgId } = params;
  if (!orgId || !params.text?.trim()) return false;
  // Extraction sends the text to an LLM: same redaction gate as embeds/Cognee.
  const redacted = redactForEmbed(params.text);
  if (redacted.skipped) return false;

  await ensureBank(orgId);
  try {
    const res = await call(
      `/v1/default/banks/${encodeURIComponent(hindsightBank(orgId))}/memories`,
      {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
          async: true,
          items: [
            {
              content: redacted.text,
              context: params.context || 'business conversation with an AI employee',
              document_id: params.documentId,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      },
      params.timeoutMs ?? 15_000,
    );
    return res.ok;
  } catch (err) {
    console.warn('[hindsight] retain failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** True when this deployment runs Hindsight (URL set, not switched off). */
export function hindsightEnabled(): boolean {
  return !!process.env.HINDSIGHT_URL?.trim() && process.env.USE_HINDSIGHT !== 'false';
}

/** Erase an org's whole bank (DSR delete). 404 = nothing was ever retained. Throws otherwise so the job retries. */
export async function deleteHindsightBank(orgId: string): Promise<void> {
  const res = await call(
    `/v1/default/banks/${encodeURIComponent(hindsightBank(orgId))}`,
    { method: 'DELETE', headers: headers() },
    30_000,
  );
  if (res.ok || res.status === 404) {
    configuredBanks.delete(orgId);
    return;
  }
  const detail = await res.text().catch(() => '');
  throw new Error(`Hindsight bank delete failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 160)}` : ''}`);
}

/** Every stored memory unit for an org (DSR export). Throws on failure so the export can say so. */
export async function exportHindsight(orgId: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const res = await call(
      `/v1/default/banks/${encodeURIComponent(hindsightBank(orgId))}/memories/list?limit=${limit}&offset=${offset}`,
      { method: 'GET', headers: headers() },
      30_000,
    );
    if (res.status === 404) return out;
    if (!res.ok) throw new Error(`Hindsight export failed: HTTP ${res.status}`);
    const page = (await res.json()) as { items?: Record<string, unknown>[]; total?: number };
    out.push(...(page.items ?? []));
    if (!page.items?.length || out.length >= (page.total ?? 0)) return out;
  }
}

export interface HindsightFact {
  id: string;
  text: string;
  /** world | experience | observation (Hindsight's own fact types). */
  type: string;
  updatedAt: string;
}

/** Newest-first facts for an org's bank, for the customer-facing Brain view. Throws on failure. */
export async function listHindsight(orgId: string, limit = 25): Promise<HindsightFact[]> {
  const res = await call(
    `/v1/default/banks/${encodeURIComponent(hindsightBank(orgId))}/memories/list?limit=${Math.min(Math.max(limit, 1), 100)}&offset=0`,
    { method: 'GET', headers: headers() },
    HINDSIGHT_TIMEOUT_MS * 2,
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Hindsight list failed: HTTP ${res.status}`);
  const page = (await res.json()) as {
    items?: Array<{ id?: string; text?: string; fact_type?: string; type?: string; mentioned_at?: string | null; date?: string | null }>;
  };
  return (page.items ?? [])
    .filter((m) => (m.text || '').trim())
    .map((m) => ({
      id: String(m.id ?? ''),
      text: String(m.text).trim(),
      type: m.fact_type || m.type || 'fact',
      updatedAt: m.mentioned_at || m.date || '',
    }));
}
