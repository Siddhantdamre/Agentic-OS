import type { GrowthSignalType } from '@darex/shared-types';

export interface DetectedSignal {
  companyName: string;
  companyDomain: string;
  signalType: GrowthSignalType;
  summary: string;
  source: string;
  payload: Record<string, unknown>;
}

const HIRING = /\b(hiring|job opening|open roles|sales team|account executive)\b/i;
const FUNDING = /\b(raised|series [a-d]|seed round|funding|venture)\b/i;
const LEADERSHIP = /\b(appointed|joins as|new (vp|cro|ceo|cto)|promoted)\b/i;

export function classifySignalText(text: string): GrowthSignalType {
  if (FUNDING.test(text)) return 'funding';
  if (HIRING.test(text)) return 'hiring';
  if (LEADERSHIP.test(text)) return 'leadership';
  return 'news';
}

export function signalsFromSearchHits(
  hits: Array<{ title?: string; url?: string; snippet?: string; description?: string }>,
  fallbackCompany = '',
): DetectedSignal[] {
  const out: DetectedSignal[] = [];
  for (const hit of hits) {
    const text = [hit.title, hit.snippet, hit.description].filter(Boolean).join(' — ');
    if (!text.trim()) continue;
    const signalType = classifySignalText(text);
    let domain = '';
    try {
      domain = hit.url ? new URL(hit.url).hostname.replace(/^www\./, '') : '';
    } catch {
      domain = '';
    }
    out.push({
      companyName: fallbackCompany || domain || 'unknown',
      companyDomain: domain,
      signalType,
      summary: text.slice(0, 280),
      source: 'web_search',
      payload: { url: hit.url || '', title: hit.title || '' },
    });
  }
  return out;
}

export async function searchBuyingSignals(query: string, timeoutMs = 12_000): Promise<DetectedSignal[]> {
  const jinaKey = process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY;
  if (!jinaKey) {
    return [];
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${jinaKey}`,
        'X-Retain-Images': 'none',
      },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ title?: string; url?: string; description?: string }> };
    const rows = Array.isArray(data.data) ? data.data.slice(0, 8) : [];
    return signalsFromSearchHits(rows);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
