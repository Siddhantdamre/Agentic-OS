/**
 * RERA public lookup (K5). Cite official cache URL + retrieved_at.
 * Never invent a registration number or legal opinion.
 */

import type { ToolRisk } from '../risk.js';
import type { ToolActionContext, ToolModule } from '../shared.js';
import {
  apiError,
  confirmFromRisk,
  dbPool,
  fetchWithTimeout,
} from '../shared.js';

const ACTIONS = ['lookup'] as const;
const DEFAULT_TTL_HOURS = parseInt(process.env.RERA_CACHE_TTL_HOURS || '24', 10);

function riskFor(_action: string): ToolRisk {
  return 'read';
}

function officialUrl(reraId: string, market: string): string {
  const configured = process.env.RERA_LOOKUP_URL || '';
  if (configured) {
    return configured.replace('{rera_id}', encodeURIComponent(reraId)).replace('{market}', encodeURIComponent(market));
  }
  if (market === 'IN-MH' || market === 'IN') {
    return `https://maharerait.mahaonline.gov.in/searchlist/search?q=${encodeURIComponent(reraId)}`;
  }
  return `https://rera.gov.in/?q=${encodeURIComponent(reraId)}`;
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, timestamp } = ctx;
  const action = actionName.includes('lookup') || actionName.includes('search') ? 'lookup' : 'lookup';
  const reraId = String(payload.rera_id || payload.reraId || payload.id || '').trim();
  const market = String(payload.market || 'IN-MH').trim() || 'IN-MH';
  if (!reraId) {
    return apiError('rera', action, timestamp, 'rera_id is required. Darex will not invent a RERA number.');
  }

  try {
    const cached = await dbPool.query(
      `SELECT rera_id, market, url, retrieved_at, expires_at, payload
         FROM rera_cache
        WHERE rera_id = $1 AND market = $2
        LIMIT 1`,
      [reraId, market]
    );
    const row = cached.rows[0] as
      | {
          rera_id: string;
          market: string;
          url: string;
          retrieved_at: Date;
          expires_at: Date;
          payload: Record<string, unknown>;
        }
      | undefined;

    if (row) {
      const stale = new Date(row.expires_at).getTime() < Date.now();
      return {
        tool: 'rera',
        action: 'lookup',
        status: 'executed' as const,
        message: stale
          ? `Cached RERA row is stale (retrieved ${new Date(row.retrieved_at).toISOString()}). Not a legal opinion.`
          : `Cached official RERA row retrieved ${new Date(row.retrieved_at).toISOString()}. Not a legal opinion.`,
        data: {
          found: true,
          stale,
          reraId: row.rera_id,
          market: row.market,
          url: row.url,
          retrieved_at: new Date(row.retrieved_at).toISOString(),
          expires_at: new Date(row.expires_at).toISOString(),
          payload: row.payload,
          legalOpinion: false,
        },
        timestamp,
      };
    }

    const fetchUrl = process.env.RERA_LOOKUP_URL;
    if (fetchUrl) {
      const url = officialUrl(reraId, market);
      const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 10_000);
      const retrievedAt = new Date();
      const expiresAt = new Date(retrievedAt.getTime() + DEFAULT_TTL_HOURS * 3600_000);
      const bodyText = await res.text().catch(() => '');
      let payloadJson: Record<string, unknown> = { httpStatus: res.status, excerpt: bodyText.slice(0, 500) };
      try {
        payloadJson = { httpStatus: res.status, ...(JSON.parse(bodyText) as Record<string, unknown>) };
      } catch {
        // keep excerpt — never invent structured fields
      }
      if (res.ok) {
        await dbPool.query(
          `INSERT INTO rera_cache (rera_id, market, url, retrieved_at, expires_at, payload)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (rera_id, market) DO UPDATE SET
             url = EXCLUDED.url,
             retrieved_at = EXCLUDED.retrieved_at,
             expires_at = EXCLUDED.expires_at,
             payload = EXCLUDED.payload,
             updated_at = NOW()`,
          [reraId, market, url, retrievedAt.toISOString(), expiresAt.toISOString(), JSON.stringify(payloadJson)]
        );
        return {
          tool: 'rera',
          action: 'lookup',
          status: 'executed' as const,
          message: `Fetched official RERA page at ${retrievedAt.toISOString()}. Not a legal opinion.`,
          data: {
            found: true,
            stale: false,
            reraId,
            market,
            url,
            retrieved_at: retrievedAt.toISOString(),
            expires_at: expiresAt.toISOString(),
            payload: payloadJson,
            legalOpinion: false,
          },
          timestamp,
        };
      }
    }

    return {
      tool: 'rera',
      action: 'lookup',
      status: 'executed' as const,
      message:
        'No official RERA cache row for this id. Set RERA_LOOKUP_URL to fetch and cache. Darex will not invent a registration number.',
      data: {
        found: false,
        stale: false,
        reraId,
        market,
        url: officialUrl(reraId, market),
        retrieved_at: null,
        cited: false,
        legalOpinion: false,
      },
      timestamp,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/rera_cache|does not exist|relation/i.test(message)) {
      return apiError(
        'rera',
        'lookup',
        timestamp,
        'rera_cache is missing — apply infra/db/migrations/015_packs.sql. Will not invent a RERA number.'
      );
    }
    return apiError('rera', 'lookup', timestamp, `RERA lookup failed: ${message}. Will not invent a number.`);
  }
}

export const rera: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
