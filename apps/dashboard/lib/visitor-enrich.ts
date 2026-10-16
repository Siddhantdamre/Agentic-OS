import { createHash } from 'crypto';
import type { PoolClient } from 'pg';

const PRICING_PATH =
  /(?:^|\/)(pricing|plans|price|checkout|subscribe|billing)(?:\/|$|\?)/i;

export type RevealCompany = {
  available: boolean;
  connected: boolean;
  reason?: string;
  companyName?: string;
  companyDomain?: string;
  raw?: Record<string, unknown>;
};

export type VisitorIntentRow = {
  orgId: string;
  ipHash: string;
  visitorId?: string | null;
  path?: string | null;
  isPricing: boolean;
  companyName?: string | null;
  companyDomain?: string | null;
  enrichmentStatus: 'pending' | 'resolved' | 'unavailable' | 'error';
  enrichmentSource: string;
};

export type DepartmentHead = {
  name?: string;
  title?: string;
  email?: string;
  linkedin?: string;
};

function isMissingTable(err: unknown, table: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = err && typeof err === 'object' ? (err as { code?: string }).code : undefined;
  if (code === '42P01') return !table || message.includes(table);
  return /does not exist|relation/i.test(message) && message.includes(table);
}

/** SHA-256 hex of a visitor IP. Never store the raw address. */
export function hashVisitorIp(ip: string): string {
  return createHash('sha256').update(String(ip || '').trim(), 'utf8').digest('hex');
}

export function clientIpFromRequest(request: Request): string | null {
  const forwarded = (request.headers.get('x-forwarded-for') || '').trim();
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      const stripped = first.replace(/^\[|\]$/g, '');
      // Only strip a trailing :port for IPv4 (single colon); IPv6 addresses contain many colons.
      const isIpv4WithPort = /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(stripped);
      return (isIpv4WithPort ? stripped.split(':')[0] : stripped) || first;
    }
  }
  const real = (request.headers.get('x-real-ip') || '').trim();
  if (real) return real;
  const cf = (request.headers.get('cf-connecting-ip') || '').trim();
  if (cf) return cf;
  return null;
}

export function isPricingPath(path: string | null | undefined): boolean {
  if (!path) return false;
  try {
    if (path.includes('://')) {
      return PRICING_PATH.test(new URL(path).pathname);
    }
  } catch {
    // fall through to raw match
  }
  return PRICING_PATH.test(path);
}

/**
 * Reverse-IP company reveal. Honest unavailable when the env is unset —
 * never fabricates a company name.
 */
export async function revealCompanyFromIp(ip: string): Promise<RevealCompany> {
  const url = (process.env.IP_REVEAL_API_URL || '').trim();
  const key = (process.env.IP_REVEAL_API_KEY || '').trim();
  if (!url || !key) {
    return {
      available: false,
      connected: false,
      reason: 'unavailable',
    };
  }
  if (!ip) {
    return { available: false, connected: true, reason: 'missing_ip' };
  }

  const endpoint = new URL(url);
  if (!endpoint.searchParams.has('ip')) endpoint.searchParams.set('ip', ip);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(endpoint.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return {
        available: false,
        connected: true,
        reason: `reveal_http_${res.status}`,
      };
    }
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return { available: false, connected: true, reason: 'reveal_empty' };
    }
    const company =
      body.company && typeof body.company === 'object'
        ? (body.company as Record<string, unknown>)
        : body;
    const companyName =
      typeof company.name === 'string'
        ? company.name
        : typeof body.name === 'string'
          ? body.name
          : undefined;
    const companyDomain =
      typeof company.domain === 'string'
        ? company.domain
        : typeof body.domain === 'string'
          ? body.domain
          : undefined;
    if (!companyName && !companyDomain) {
      return { available: false, connected: true, reason: 'unresolved', raw: body };
    }
    return {
      available: true,
      connected: true,
      companyName,
      companyDomain,
      raw: body,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      connected: true,
      reason: /abort/i.test(message) ? 'reveal_timeout' : 'reveal_failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

export type UpsertVisitorIntentResult = {
  ok: boolean;
  missingTable: boolean;
  pricingPageVisits: number;
  leadCreatedAt: string | null;
};

export async function upsertVisitorIntent(
  client: PoolClient,
  row: VisitorIntentRow
): Promise<UpsertVisitorIntentResult> {
  const pricingInc = row.isPricing ? 1 : 0;
  try {
    const res = await client.query<{ pricing_page_visits: number; lead_created_at: Date | string | null }>(
      `INSERT INTO visitor_company_intent (
         org_id, ip_hash, visitor_id, last_path,
         company_name, company_domain,
         enrichment_source, enrichment_status,
         pricing_page_visits, last_seen_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       ON CONFLICT (org_id, ip_hash) DO UPDATE SET
         visitor_id = CASE
           WHEN EXCLUDED.visitor_id <> '' THEN EXCLUDED.visitor_id
           ELSE visitor_company_intent.visitor_id
         END,
         last_path = EXCLUDED.last_path,
         company_name = CASE
           WHEN EXCLUDED.company_name <> '' THEN EXCLUDED.company_name
           ELSE visitor_company_intent.company_name
         END,
         company_domain = CASE
           WHEN EXCLUDED.company_domain <> '' THEN EXCLUDED.company_domain
           ELSE visitor_company_intent.company_domain
         END,
         enrichment_source = EXCLUDED.enrichment_source,
         enrichment_status = EXCLUDED.enrichment_status,
         pricing_page_visits = visitor_company_intent.pricing_page_visits + EXCLUDED.pricing_page_visits,
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING pricing_page_visits, lead_created_at`,
      [
        row.orgId,
        row.ipHash,
        row.visitorId || '',
        row.path || '',
        row.companyName || '',
        row.companyDomain || '',
        row.enrichmentSource,
        row.enrichmentStatus,
        pricingInc,
      ]
    );
    const saved = res.rows[0];
    return {
      ok: true,
      missingTable: false,
      pricingPageVisits: saved ? Number(saved.pricing_page_visits) : pricingInc,
      leadCreatedAt: saved?.lead_created_at
        ? saved.lead_created_at instanceof Date
          ? saved.lead_created_at.toISOString()
          : String(saved.lead_created_at)
        : null,
    };
  } catch (err: unknown) {
    if (isMissingTable(err, 'visitor_company_intent')) {
      return { ok: false, missingTable: true, pricingPageVisits: 0, leadCreatedAt: null };
    }
    throw err;
  }
}

/** GE-04 frequency gate: only convert a visitor into a lead at 2+ pricing-page visits in 24h. */
export function crossesVisitFrequencyGate(pricingPageVisits: number, leadCreatedAt: string | null): boolean {
  return pricingPageVisits >= 2 && !leadCreatedAt;
}

export async function markVisitorLeadCreated(client: PoolClient, orgId: string, ipHash: string): Promise<void> {
  try {
    await client.query(
      `UPDATE visitor_company_intent SET lead_created_at = NOW(), updated_at = NOW()
        WHERE org_id = $1 AND ip_hash = $2`,
      [orgId, ipHash]
    );
  } catch (err: unknown) {
    if (!isMissingTable(err, 'visitor_company_intent')) throw err;
  }
}

/**
 * GE-04 department-head discovery. Looks up a decision-maker at the
 * resolved company domain via Apollo before a lead card is created.
 * Honest unavailable when no platform Apollo key is configured — never
 * fabricates a contact.
 */
export async function findDepartmentHead(domain: string): Promise<{ available: boolean; contact?: DepartmentHead }> {
  const apiKey = (process.env.APOLLO_API_KEY || '').trim();
  if (!apiKey || !domain) {
    return { available: false };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({
        q_organization_domains: domain,
        person_titles: ['VP Sales', 'Head of Growth', 'CEO', 'Founder', 'Director of Sales'],
        page: 1,
        per_page: 1,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { available: false };
    const data = (await res.json().catch(() => null)) as { people?: Array<Record<string, unknown>> } | null;
    const person = data?.people?.[0];
    if (!person) return { available: false };
    const firstName = typeof person.first_name === 'string' ? person.first_name : '';
    const lastName = typeof person.last_name === 'string' ? person.last_name : '';
    const rawEmail = typeof person.email === 'string' ? person.email : '';
    return {
      available: true,
      contact: {
        name: [firstName, lastName].filter(Boolean).join(' ') || undefined,
        title: typeof person.title === 'string' ? person.title : undefined,
        email: rawEmail && !rawEmail.includes('not_unlocked') ? rawEmail : undefined,
        linkedin: typeof person.linkedin_url === 'string' ? person.linkedin_url : undefined,
      },
    };
  } catch {
    return { available: false };
  } finally {
    clearTimeout(timer);
  }
}
