/**
 * Cognee Knowledge Graph Memory Client
 *
 * Connects Darex agent runtime to Cognee's ECL (Extract, Cognify, Load) memory engine.
 * Provides multi-hop knowledge graph search and automated conversation write-back.
 */

import type { MemoryCitation } from '@darex/shared-types';
import { redactForEmbed } from '../activities/redact.js';

const rawCogneeUrl = process.env.COGNEE_URL || '';

// ---------------------------------------------------------------------------
// Circuit breaker — prevents hammering Cognee when it is consistently failing.
// Tripped by callers (retrieve.ts) on repeated errors; auto-closes after 60 s.
// ---------------------------------------------------------------------------
let _circuitOpen = false;
let _circuitOpenAt = 0;
const CIRCUIT_RESET_MS = 60_000;

export function isCogneeCircuitOpen(): boolean {
  if (_circuitOpen && Date.now() - _circuitOpenAt > CIRCUIT_RESET_MS) {
    _circuitOpen = false; // auto-close after timeout
  }
  return _circuitOpen;
}

export function tripCogneeCircuit(): void {
  _circuitOpen = true;
  _circuitOpenAt = Date.now();
}

export function closeCogneeCircuit(): void {
  _circuitOpen = false;
  _circuitOpenAt = 0;
}
const COGNEE_URL =
  rawCogneeUrl && !rawCogneeUrl.includes('host.docker.internal')
    ? rawCogneeUrl
    : (process.env.DB_HOST === 'pgbouncer' ? 'http://cognee:8000' : (rawCogneeUrl || 'http://127.0.0.1:8000'));
const COGNEE_TIMEOUT_MS = parseInt(process.env.COGNEE_TIMEOUT_MS || '3500', 10);

/**
 * Cognee's server accepts either a user API key (`X-Api-Key`, minted via its
 * /api/v1/auth/api-keys router) or a login JWT (`Authorization: Bearer`).
 * Enforcement is REQUIRE_AUTHENTICATION=true on the cognee service; the key
 * is sent both ways so either credential type works.
 */
function cogneeAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra || {}) };
  const apiKey = process.env.COGNEE_API_KEY?.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
    headers['X-Api-Key'] = apiKey;
  }
  return headers;
}

export interface CogneeSearchParams {
  orgId: string;
  query: string;
  searchType?: 'GRAPH_COMPLETION' | 'HYBRID_COMPLETION' | 'CHUNKS' | 'SUMMARIES';
  topK?: number;
  timeoutMs?: number;
}

export interface CogneeRememberParams {
  orgId: string;
  text: string;
  sessionId?: string;
  timeoutMs?: number;
}

/**
 * Checks if Cognee API service is reachable. Probes /health (the endpoint the
 * container healthcheck uses); falls back to /docs for older servers where
 * /health may not exist. /docs alone is not a health signal (Swagger UI can
 * serve while the API is down).
 */
export async function isCogneeHealthy(timeoutMs = 800): Promise<boolean> {
  for (const path of ['/health', '/docs']) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${COGNEE_URL}${path}`, {
        method: 'GET',
        headers: cogneeAuthHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) return true;
    } catch {
      // try next probe path
    }
  }
  return false;
}

/**
 * Parses structured graph context into discrete factual snippets.
 */
function parseGraphSnippets(rawText: string): string[] {
  const snippets: string[] = [];
  const nodeMatches = rawText.matchAll(/__node_content_start__\s*([\s\S]*?)\s*__node_content_end__/g);
  for (const match of nodeMatches) {
    const text = match[1].trim();
    if (
      text &&
      text !== 'None' &&
      text.length > 8 &&
      !text.startsWith('This chunk is about:') &&
      !snippets.includes(text)
    ) {
      snippets.push(text);
    }
  }

  // Also capture explicit connections between entities
  const connSection = rawText.split(/Connections:\s*/)[1];
  if (connSection) {
    const lines = connSection
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('--[') && l.includes(']-->'));
    for (const line of lines) {
      if (!snippets.includes(line)) {
        snippets.push(line);
      }
    }
  }

  return snippets;
}

// Which org datasets Cognee holds, so a search for an org with no memory yet skips the slow
// /search call. A cached "no" is re-checked after DATASET_MISS_RECHECK_MS: another process (the
// dashboard or a second worker) may have created the dataset since, and a stale "no" would hide
// real memory from the agent.
const DATASET_CACHE_TTL_MS = 30_000;
const DATASET_MISS_RECHECK_MS = 5_000;
const DATASET_LOOKUP_TIMEOUT_MS = 2_000;
let datasetNames: Set<string> | null = null;
let datasetNamesAt = 0;

/** Test hook: forget the cached dataset list. */
export function resetCogneeDatasetCache(): void {
  datasetNames = null;
  datasetNamesAt = 0;
}

/** False only when Cognee answered the list and the org has no dataset. Any doubt says true, so a search still runs. */
export async function hasCogneeDataset(orgId: string): Promise<boolean> {
  const name = `org_${orgId}`;
  const age = Date.now() - datasetNamesAt;
  if (datasetNames && age < DATASET_CACHE_TTL_MS) {
    if (datasetNames.has(name)) return true;
    if (age < DATASET_MISS_RECHECK_MS) return false;
  }
  try {
    const res = await cogneeCall('/api/v1/datasets', { method: 'GET', headers: cogneeAuthHeaders() }, DATASET_LOOKUP_TIMEOUT_MS);
    if (!res.ok) return true;
    const list = (await res.json()) as unknown;
    if (!Array.isArray(list)) return true;
    // Names only: an entry we cannot read means the response shape changed, so do not trust "missing".
    if (list.some((d) => typeof d !== 'object' || d === null || typeof (d as { name?: unknown }).name !== 'string')) return true;
    datasetNames = new Set(list.map((d) => (d as { name: string }).name));
    datasetNamesAt = Date.now();
    return datasetNames.has(name);
  } catch (err: any) {
    console.warn('[cognee] dataset lookup failed, searching anyway:', err?.message);
    return true;
  }
}

/**
 * Searches the Cognee Knowledge Graph for an organization dataset.
 * Returns citations with multi-hop relational context.
 */
export async function searchCognee(params: CogneeSearchParams): Promise<MemoryCitation[]> {
  const { orgId, query } = params;
  if (!orgId || !query || !query.trim()) return [];

  // Before the search timer starts: the lookup must not eat the search's time budget, and an
  // early return must not leave that timer running.
  if (!(await hasCogneeDataset(orgId))) return [];

  const timeoutMs = params.timeoutMs ?? COGNEE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const datasetName = `org_${orgId}`;
  if (!(await hasCogneeDataset(orgId))) return [];

  try {
    const res = await fetch(`${COGNEE_URL}/api/v1/search`, {
      method: 'POST',
      headers: cogneeAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        query: query.trim(),
        search_type: params.searchType || 'GRAPH_COMPLETION',
        datasets: [datasetName],
        only_context: true,
        top_k: params.topK ?? 10,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // 404 / dataset-missing is a normal empty graph for new tenants.
      if (res.status === 404) return [];
      const detail = await res.text().catch(() => '');
      if (res.status < 500 && /dataset.?not.?found|not found/i.test(detail)) return [];
      throw new Error(`Cognee search failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 160)}` : ''}`);
    }

    const data = (await res.json()) as any;
    const rawContext = Array.isArray(data) ? String(data[0] || '') : typeof data === 'string' ? data : '';
    if (!rawContext.trim()) return [];

    const snippets = parseGraphSnippets(rawContext);

    const citations: MemoryCitation[] = [];
    let n = 1;
    for (const snippet of snippets) {
      citations.push({
        // G- namespace: pgvector fallback uses M-, so mixed provenance never
        // collides and the model can tell graph facts from row facts.
        id: `G-${n++}`,
        tier: 'graph',
        snippet,
        source: 'graph',
        sourceRef: `cognee:${datasetName}`,
        // Honest freshness: Cognee context carries no per-snippet timestamp,
        // so updatedAt is empty (rendered as "no date") instead of faking now.
        stale: false,
        updatedAt: '',
      });
      if (citations.length >= (params.topK ?? 8)) break;
    }

    return citations;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      console.warn('[cognee] Search timed out after', timeoutMs, 'ms');
      throw new Error(`Cognee search timed out after ${timeoutMs}ms`);
    }
    // Re-throw so callers (tool executor, memory retrieve) can fail honestly
    // or fall back — never look like a successful empty graph.
    if (err instanceof Error && /Cognee search failed/i.test(err.message)) throw err;
    console.warn('[cognee] Search failed:', err?.message || err);
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stores factual knowledge or conversation history in the Cognee Knowledge Graph.
 * Triggers entity extraction, graph synthesis, and embedding.
 */
export async function rememberCognee(params: CogneeRememberParams): Promise<boolean> {
  const { orgId } = params;
  if (!orgId || !params.text || !params.text.trim()) return false;
  // Cognee cognify sends the text to an external LLM. Strip secrets / PAN /
  // Aadhaar / card numbers here so every caller (write-back, the remember
  // tool) goes through the same gate as the pgvector embed path.
  const redacted = redactForEmbed(params.text);
  if (redacted.skipped) return false;
  const text = redacted.text;

  const timeoutMs = params.timeoutMs ?? 45000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const datasetName = `org_${orgId}`;
  try {
    const formData = new FormData();
    formData.append('raw_data', text);
    formData.append('datasetName', datasetName);
    if (params.sessionId) {
      formData.append('session_id', params.sessionId);
    }

    const res = await fetch(`${COGNEE_URL}/api/v1/remember`, {
      method: 'POST',
      headers: cogneeAuthHeaders(),
      body: formData,
      signal: controller.signal,
    });

    if (res.ok && datasetNames) {
      datasetNames.add(datasetName);
    }
    return res.ok;
  } catch (err: any) {
    console.warn('[cognee] Remember failed:', err?.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** True when this deployment runs Cognee (URL set, not switched off). */
export function cogneeEnabled(): boolean {
  return !!process.env.COGNEE_URL?.trim() && process.env.USE_COGNEE !== 'false';
}

async function cogneeCall(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${COGNEE_URL}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Dataset id for an org, or null when the org never had a graph. Throws if Cognee cannot answer. */
async function findCogneeDatasetId(orgId: string): Promise<string | null> {
  const res = await cogneeCall('/api/v1/datasets', { method: 'GET', headers: cogneeAuthHeaders() }, 15_000);
  if (!res.ok) throw new Error(`Cognee dataset list failed: HTTP ${res.status}`);
  const list = (await res.json()) as Array<{ id?: string; name?: string }>;
  const name = `org_${orgId}`;
  return list.find((d) => d.name === name)?.id ?? null;
}

/** Erase an org's whole graph (DSR delete). No dataset = nothing to erase. Throws otherwise so the job retries. */
export async function deleteCogneeDataset(orgId: string): Promise<void> {
  const id = await findCogneeDatasetId(orgId);
  if (!id) return;
  if (datasetNames) {
    datasetNames.delete(`org_${orgId}`);
  }
  const res = await cogneeCall(`/api/v1/datasets/${encodeURIComponent(id)}`, { method: 'DELETE', headers: cogneeAuthHeaders() }, 60_000);
  if (res.ok || res.status === 404) return;
  const detail = await res.text().catch(() => '');
  throw new Error(`Cognee dataset delete failed: HTTP ${res.status}${detail ? ` ${detail.slice(0, 160)}` : ''}`);
}

/** Source records behind an org's graph (DSR export). Throws on failure so the export can say so. */
export async function exportCognee(orgId: string): Promise<Record<string, unknown>[]> {
  const id = await findCogneeDatasetId(orgId);
  if (!id) return [];
  const res = await cogneeCall(`/api/v1/datasets/${encodeURIComponent(id)}/data`, { method: 'GET', headers: cogneeAuthHeaders() }, 30_000);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Cognee export failed: HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>[];
  return Array.isArray(data) ? data : [];
}
