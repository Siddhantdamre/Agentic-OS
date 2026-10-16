import { ApplicationFailure } from '@temporalio/activity';
import type {
  GrowthOpportunityPayload,
  IcpProfile,
  PreferenceRule,
  RankedCandidate,
  WonAccountFeatures,
} from '@darex/shared-types';
import { readIdempotent, sideEffectKey, withOrgClient, writeIdempotent } from '../db.js';
import { emptyIcp, buildIcpProfile, candidateFromApolloPerson, rankCandidates } from '../growth/lookalike.js';
import { distillRulesViaLlm, heuristicRulesFromComment, mergePreferenceRules } from '../growth/preferences.js';
import { searchBuyingSignals, type DetectedSignal } from '../growth/signals.js';
import { synthesizeWhyNow } from '../growth/why-now.js';
import { classifyReply } from '../growth/reply-classifier.js';
import { getNangoAccessToken } from '../tools/shared.js';
import { executeAutonomousToolAction } from '../tool-executor.js';

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

async function fetchClosedWonAccounts(orgId: string): Promise<{ connected: boolean; accounts: WonAccountFeatures[] }> {
  const token = await getNangoAccessToken(`${orgId}_hubspot`, 'hubspot');
  if (!token) {
    return { connected: false, accounts: [] };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filterGroups: [
          {
            filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }],
          },
        ],
        properties: ['dealname', 'amount', 'industry', 'hs_analytics_latest_source'],
        sorts: [{ propertyName: 'amount', direction: 'DESCENDING' }],
        limit: 20,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { connected: true, accounts: [] };
    const data = (await res.json()) as {
      results?: Array<{ properties?: Record<string, string | null> }>;
    };
    const accounts: WonAccountFeatures[] = (data.results || []).map((row) => ({
      companyName: row.properties?.dealname || 'unknown',
      industry: row.properties?.industry || undefined,
      amountCents: row.properties?.amount ? Math.round(Number(row.properties.amount) * 100) : undefined,
    }));
    return { connected: true, accounts };
  } catch {
    return { connected: true, accounts: [] };
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadOrBuildIcpActivity(params: {
  orgId: string;
  maxAgeDays?: number;
  businessKey: string;
}): Promise<{ icp: IcpProfile; source: 'cache' | 'crm' | 'empty'; connected: boolean }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'loadOrBuildIcp', params.businessKey);
  const cached = await readIdempotent<{ icp: IcpProfile; source: 'cache' | 'crm' | 'empty'; connected: boolean }>(
    orgId,
    key,
  );
  if (cached) return cached;

  const maxAgeDays = params.maxAgeDays ?? 7;
  const existing = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT profile, sample_size, computed_at
         FROM growth_icp_profiles
        WHERE org_id = $1
        LIMIT 1`,
      [orgId],
    );
    return res.rows[0] as { profile: IcpProfile; sample_size: number; computed_at: Date } | undefined;
  }).catch(() => undefined);

  if (existing?.computed_at) {
    const ageMs = Date.now() - new Date(existing.computed_at).getTime();
    if (ageMs < maxAgeDays * 86_400_000 && existing.profile) {
      const out = { icp: existing.profile, source: 'cache' as const, connected: true };
      await writeIdempotent(orgId, key, out);
      return out;
    }
  }

  const fetched = await fetchClosedWonAccounts(orgId);
  const icp = fetched.accounts.length > 0 ? buildIcpProfile(fetched.accounts) : emptyIcp();
  await withOrgClient(orgId, async (client) => {
    await client.query(
      `INSERT INTO growth_icp_profiles (org_id, profile, sample_size, source, computed_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (org_id) DO UPDATE
         SET profile = EXCLUDED.profile,
             sample_size = EXCLUDED.sample_size,
             source = EXCLUDED.source,
             computed_at = NOW(),
             updated_at = NOW()`,
      [orgId, JSON.stringify(icp), icp.sampleSize, fetched.connected ? 'crm' : 'empty'],
    );
  }).catch(() => undefined);

  const out = {
    icp,
    source: fetched.accounts.length > 0 ? ('crm' as const) : ('empty' as const),
    connected: fetched.connected,
  };
  await writeIdempotent(orgId, key, out);
  return out;
}

/**
 * GE-01 Twin Customer Finder — auto-populates lookalike candidates from a
 * real Apollo people search against the closed-won ICP, instead of relying
 * solely on inbound signals/visitor intent. Honest empty when Apollo is not
 * connected for the org (apollo tool returns notConnected, never fabricated).
 */
export async function searchLookalikeCandidatesActivity(params: {
  orgId: string;
  icp: IcpProfile;
  businessKey: string;
}): Promise<{ candidates: Array<Omit<RankedCandidate, 'fit' | 'now' | 'score'>>; searched: boolean }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'searchLookalikeCandidates', params.businessKey);
  const cached = await readIdempotent<{
    candidates: Array<Omit<RankedCandidate, 'fit' | 'now' | 'score'>>;
    searched: boolean;
  }>(orgId, key);
  if (cached) return cached;

  const industry = params.icp.industries[0];
  if (!industry) {
    const out = { candidates: [], searched: false };
    await writeIdempotent(orgId, key, out);
    return out;
  }
  const title = params.icp.decisionMakerTitles[0] || 'vp sales';
  const timestamp = new Date().toISOString();

  const result = await executeAutonomousToolAction({
    tool: 'apollo',
    action: 'search_people',
    payload: { query: `${title} ${industry}` },
    orgId,
    employeeRole: 'marketing',
    source: 'sweep',
  }).catch(() => null);

  const searched = result?.status === 'executed';
  const people = searched && result?.data && typeof result.data === 'object'
    ? ((result.data as { people?: unknown[] }).people || [])
    : [];

  const candidates = people
    .map((p) => candidateFromApolloPerson((p || {}) as Record<string, unknown>, params.icp))
    .filter((c): c is Omit<RankedCandidate, 'fit' | 'now' | 'score'> => Boolean(c))
    .slice(0, 25);

  const out = { candidates, searched };
  await writeIdempotent(orgId, key, out);
  return out;
}

export async function pollSignalsActivity(params: {
  orgId: string;
  sinceHours?: number;
  businessKey: string;
}): Promise<{ signals: DetectedSignal[]; searched: boolean }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'pollSignals', params.businessKey);
  const cached = await readIdempotent<{ signals: DetectedSignal[]; searched: boolean }>(orgId, key);
  if (cached) return cached;

  const icp = await withOrgClient(orgId, async (client) => {
    const res = await client.query(`SELECT profile FROM growth_icp_profiles WHERE org_id = $1 LIMIT 1`, [orgId]);
    return (res.rows[0]?.profile || emptyIcp()) as IcpProfile;
  }).catch(() => emptyIcp());

  const industry = icp.industries[0] || 'saas';
  const geo = icp.geos[0] || 'india';
  const query = `${industry} ${geo} hiring OR funding OR "vp sales"`;
  const signals = await searchBuyingSignals(query);
  const out = { signals, searched: Boolean(process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY) };
  await writeIdempotent(orgId, key, out);
  return out;
}

export async function persistSignalsActivity(params: {
  orgId: string;
  signals: DetectedSignal[];
  businessKey: string;
}): Promise<{ inserted: number }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'persistSignals', params.businessKey);
  const cached = await readIdempotent<{ inserted: number }>(orgId, key);
  if (cached) return cached;

  let inserted = 0;
  await withOrgClient(orgId, async (client) => {
    for (const s of params.signals) {
      await client.query(
        `INSERT INTO lead_intent_signals
           (org_id, company_name, company_domain, signal_type, summary, payload, source, detected_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [orgId, s.companyName, s.companyDomain, s.signalType, s.summary, JSON.stringify(s.payload), s.source],
      );
      inserted += 1;
    }
  }).catch(() => undefined);

  const out = { inserted };
  await writeIdempotent(orgId, key, out);
  return out;
}

export async function loadPreferencesActivity(params: {
  orgId: string;
  businessKey: string;
}): Promise<{ rules: PreferenceRule[] }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'loadPreferences', params.businessKey);
  const cached = await readIdempotent<{ rules: PreferenceRule[] }>(orgId, key);
  if (cached) return cached;
  const rules = await withOrgClient(orgId, async (client) => {
    const res = await client.query(`SELECT rules FROM org_preferences WHERE org_id = $1 LIMIT 1`, [orgId]);
    return (Array.isArray(res.rows[0]?.rules) ? res.rows[0].rules : []) as PreferenceRule[];
  }).catch(() => [] as PreferenceRule[]);
  const out = { rules };
  await writeIdempotent(orgId, key, out);
  return out;
}

export async function rankCandidatesActivity(params: {
  orgId: string;
  icp: IcpProfile;
  signals: DetectedSignal[];
  prefs: PreferenceRule[];
  businessKey: string;
  externalCandidates?: Array<Omit<RankedCandidate, 'fit' | 'now' | 'score'>>;
}): Promise<{ ranked: RankedCandidate[] }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'rankCandidates', params.businessKey);
  const cached = await readIdempotent<{ ranked: RankedCandidate[] }>(orgId, key);
  if (cached) return cached;

  const intent = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT company_name, company_domain, pricing_page_visits, last_seen_at
         FROM visitor_company_intent
        WHERE org_id = $1 AND company_name <> ''
        ORDER BY last_seen_at DESC
        LIMIT 25`,
      [orgId],
    );
    return res.rows as Array<{
      company_name: string;
      company_domain: string;
      pricing_page_visits: number;
      last_seen_at: string;
    }>;
  }).catch(() => []);

  const byDomain = new Map<string, Omit<RankedCandidate, 'fit' | 'now' | 'score'>>();
  for (const s of params.signals) {
    const domain = s.companyDomain || s.companyName.toLowerCase();
    const existing = byDomain.get(domain);
    const signal = { type: s.signalType, summary: s.summary, timestamp: new Date().toISOString() };
    if (existing) {
      existing.activeSignals.push(signal);
    } else {
      byDomain.set(domain, {
        companyName: s.companyName,
        domain,
        industry: params.icp.industries[0],
        geo: params.icp.geos[0],
        headcount: Math.round((params.icp.employeeMin + params.icp.employeeMax) / 2),
        activeSignals: [signal],
      });
    }
  }
  for (const row of intent) {
    const domain = row.company_domain || row.company_name.toLowerCase();
    const signal = {
      type: 'intent' as const,
      summary: `Pricing page visited ${row.pricing_page_visits}×`,
      timestamp: String(row.last_seen_at),
    };
    const existing = byDomain.get(domain);
    if (existing) existing.activeSignals.push(signal);
    else {
      byDomain.set(domain, {
        companyName: row.company_name,
        domain,
        industry: params.icp.industries[0],
        geo: params.icp.geos[0],
        activeSignals: [signal],
      });
    }
  }

  for (const ext of params.externalCandidates || []) {
    const existing = byDomain.get(ext.domain);
    if (existing) {
      existing.contactName = existing.contactName || ext.contactName;
      existing.contactEmail = existing.contactEmail || ext.contactEmail;
      existing.title = existing.title || ext.title;
      existing.linkedin = existing.linkedin || ext.linkedin;
      existing.headcount = existing.headcount ?? ext.headcount;
      existing.techTags = existing.techTags?.length ? existing.techTags : ext.techTags;
    } else {
      byDomain.set(ext.domain, {
        ...ext,
        activeSignals: [
          {
            type: 'other',
            summary: 'Twin Customer Finder: matches your closed-won ICP centroid (Apollo)',
            timestamp: new Date().toISOString(),
          },
        ],
      });
    }
  }

  const ranked = rankCandidates([...byDomain.values()], params.icp, params.prefs);
  const out = { ranked };
  await writeIdempotent(orgId, key, out);
  return out;
}

async function opportunityPayload(orgId: string, candidate: RankedCandidate): Promise<GrowthOpportunityPayload> {
  const hiring = candidate.activeSignals.find((s) => s.type === 'hiring');
  const title = candidate.title || 'VP Sales';
  const name = candidate.contactName || 'decision maker';
  const wonDeals = (await fetchClosedWonAccounts(orgId).catch(() => ({ accounts: [] }))).accounts;
  const whyNow = await synthesizeWhyNow(candidate, wonDeals);
  return {
    companyName: candidate.companyName,
    companyDomain: candidate.domain,
    icpScore: candidate.score,
    whyThisCompany: `ICP fit ${candidate.score}/100 — industry/size/geo aligned with closed-won centroid.`,
    targetContact: {
      name,
      title,
      email: candidate.contactEmail,
      linkedin: candidate.linkedin,
    },
    whyThisPerson: `${name} (${title}) owns the revenue problem this lookalike cohort bought to solve.`,
    buyingSignals: candidate.activeSignals,
    whyNow,
    draftedMessage: {
      subject: `${candidate.companyName} — similar to your best customers`,
      body: `Saw ${candidate.companyName} ${hiring ? 'hiring' : 'moving'} and wanted to share how peers in the same band solved this.`,
    },
  };
}

export async function createOpportunityActivity(params: {
  orgId: string;
  candidate: RankedCandidate;
  businessKey: string;
}): Promise<{ workItemId: string; created: boolean }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'createOpportunity', params.businessKey);
  const cached = await readIdempotent<{ workItemId: string; created: boolean }>(orgId, key);
  if (cached) return cached;

  const payload = await opportunityPayload(orgId, params.candidate);
  const saved = await withOrgClient(orgId, async (client) => {
    const existing = await client.query(
      `SELECT id FROM work_items
        WHERE org_id = $1 AND type = 'growth_opportunity'
          AND metadata->'card'->>'companyDomain' = $2
          AND status IN ('open', 'needs_attention', 'waiting_approval')
        LIMIT 1`,
      [orgId, params.candidate.domain],
    );
    if (existing.rows[0]?.id) {
      return { workItemId: existing.rows[0].id as string, created: false };
    }
    const inserted = await client.query(
      `INSERT INTO work_items (org_id, type, status, channel, priority, metadata)
       VALUES ($1, 'growth_opportunity', 'needs_attention', 'ask_ai', $2, $3)
       RETURNING id`,
      [
        orgId,
        params.candidate.score >= 85 ? 'high' : 'normal',
        JSON.stringify({ card: payload, recommendedAction: 'send_outreach' }),
      ],
    );
    return { workItemId: inserted.rows[0].id as string, created: true };
  });

  await writeIdempotent(orgId, key, saved);
  return saved;
}

export async function synthesizePreferencesActivity(params: {
  orgId: string;
  businessKey: string;
}): Promise<{ synthesized: number; rules: PreferenceRule[] }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'synthesizePreferences', params.businessKey);
  const cached = await readIdempotent<{ synthesized: number; rules: PreferenceRule[] }>(orgId, key);
  if (cached) return cached;

  const rows = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT id, comment FROM ask_ai_feedback
        WHERE org_id = $1 AND vote = 'down' AND synthesized_at IS NULL
        ORDER BY created_at ASC
        LIMIT 25`,
      [orgId],
    );
    return res.rows as Array<{ id: string; comment: string | null }>;
  }).catch(() => []);

  const incoming: PreferenceRule[] = [];
  for (const row of rows) {
    incoming.push(...heuristicRulesFromComment(row.comment || ''));
  }
  incoming.push(...(await distillRulesViaLlm(rows.map((r) => r.comment || ''))));

  const existing = await withOrgClient(orgId, async (client) => {
    const res = await client.query(`SELECT rules FROM org_preferences WHERE org_id = $1 LIMIT 1`, [orgId]);
    return (Array.isArray(res.rows[0]?.rules) ? res.rows[0].rules : []) as PreferenceRule[];
  }).catch(() => [] as PreferenceRule[]);

  const rules = mergePreferenceRules(existing, incoming);
  await withOrgClient(orgId, async (client) => {
    await client.query(
      `INSERT INTO org_preferences (org_id, rules, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (org_id) DO UPDATE SET rules = EXCLUDED.rules, updated_at = NOW()`,
      [orgId, JSON.stringify(rules)],
    );
    if (rows.length > 0) {
      await client.query(
        `UPDATE ask_ai_feedback SET synthesized_at = NOW()
          WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [orgId, rows.map((r) => r.id)],
      );
    }
  }).catch(() => undefined);

  const out = { synthesized: rows.length, rules };
  await writeIdempotent(orgId, key, out);
  return out;
}

export async function listDormantLeadsActivity(params: {
  orgId: string;
  staleDays?: number;
  businessKey: string;
}): Promise<{ leads: Array<{ companyName: string; domain: string; lastActivity: string | null }> }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'listDormantLeads', params.businessKey);
  const cached = await readIdempotent<{
    leads: Array<{ companyName: string; domain: string; lastActivity: string | null }>;
  }>(orgId, key);
  if (cached) return cached;

  const staleDays = params.staleDays ?? 180;
  const leads = await withOrgClient(orgId, async (client) => {
    const conv = await client.query(
      `SELECT DISTINCT ON (c.id)
              COALESCE(c.summary, c.contact_id, 'dormant lead') AS company_name,
              c.updated_at
         FROM conversations c
        WHERE c.org_id = $1
          AND c.updated_at < NOW() - ($2::int || ' days')::interval
        ORDER BY c.id, c.updated_at DESC
        LIMIT 40`,
      [orgId, staleDays],
    );
    const signals = await client.query(
      `SELECT company_name, company_domain FROM lead_intent_signals
        WHERE org_id = $1 AND detected_at > NOW() - INTERVAL '14 days'`,
      [orgId],
    );
    const fresh = new Set(
      signals.rows.map((r: { company_name: string; company_domain: string }) =>
        String(r.company_domain || r.company_name).toLowerCase(),
      ),
    );
    return conv.rows
      .map((r: { company_name: string; updated_at: string }) => ({
        companyName: r.company_name,
        domain: String(r.company_name).toLowerCase().replace(/\s+/g, ''),
        lastActivity: r.updated_at,
      }))
      .filter((l: { domain: string; companyName: string }) =>
        [...fresh].some((f) => l.domain.includes(f) || f.includes(l.companyName.toLowerCase())),
      );
  }).catch(() => []);

  const out = { leads };
  await writeIdempotent(orgId, key, out);
  return out;
}

export async function recordGrowthRoiActivity(params: {
  orgId: string;
  opportunityWorkItemId?: string;
  stage: 'created' | 'qualified' | 'conversation' | 'meeting' | 'won' | 'lost';
  estimatedValueCents?: number;
  currency?: string;
  crmDealId?: string;
  businessKey: string;
}): Promise<{ id: string | null }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'recordGrowthRoi', params.businessKey);
  const cached = await readIdempotent<{ id: string | null }>(orgId, key);
  if (cached) return cached;
  const saved = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `INSERT INTO growth_pipeline_attribution
         (org_id, opportunity_work_item_id, crm_deal_id, stage, estimated_value_cents, currency)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        orgId,
        params.opportunityWorkItemId || null,
        params.crmDealId || null,
        params.stage,
        params.estimatedValueCents || 0,
        params.currency || 'USD',
      ],
    );
    return { id: res.rows[0]?.id as string };
  }).catch(() => ({ id: null }));
  await writeIdempotent(orgId, key, saved);
  return saved;
}

/**
 * GE-02 Market Scout — autonomous background scraper. Searches Apollo for
 * decision-makers matching the org's ICP, capped to a daily lead budget
 * (env GROWTH_SCOUT_DAILY_LEAD_CAP, default 25), and inserts each new lead
 * into the connected CRM (HubSpot). When HubSpot is not connected the lead
 * still surfaces as a growth_opportunity work item so nothing is silently
 * dropped — never fabricates a CRM sync that did not happen.
 */
export async function runMarketScoutActivity(params: {
  orgId: string;
  businessKey: string;
  dailyCapOverride?: number;
}): Promise<{ searched: boolean; found: number; inserted: number; dailyCap: number }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'runMarketScout', params.businessKey);
  const cached = await readIdempotent<{ searched: boolean; found: number; inserted: number; dailyCap: number }>(
    orgId,
    key,
  );
  if (cached) return cached;

  const dailyCap = params.dailyCapOverride ?? parseInt(process.env.GROWTH_SCOUT_DAILY_LEAD_CAP || '25', 10);

  const icpResult = await loadOrBuildIcpActivity({ orgId, businessKey: `${params.businessKey}:icp` });
  const icp = icpResult.icp;
  const industry = icp.industries[0] || 'saas';
  const title = icp.decisionMakerTitles[0] || 'vp sales';

  const alreadyToday = await withOrgClient(orgId, async (client) => {
    const res = await client.query(
      `SELECT COUNT(*)::int AS n FROM growth_scout_leads
        WHERE org_id = $1 AND scouted_at > NOW() - INTERVAL '24 hours'`,
      [orgId],
    );
    return (res.rows[0]?.n as number) || 0;
  }).catch(() => 0);

  const budgetRemaining = Math.max(0, dailyCap - alreadyToday);
  if (budgetRemaining <= 0) {
    const out = { searched: false, found: 0, inserted: 0, dailyCap };
    await writeIdempotent(orgId, key, out);
    return out;
  }

  const timestamp = new Date().toISOString();
  const result = await executeAutonomousToolAction({
    tool: 'apollo',
    action: 'search_people',
    payload: { query: `${title} ${industry}` },
    orgId,
    employeeRole: 'marketing',
    source: 'sweep',
  }).catch(() => null);

  const searched = result?.status === 'executed';
  const people = searched && result?.data && typeof result.data === 'object'
    ? ((result.data as { people?: Array<Record<string, unknown>> }).people || [])
    : [];

  let inserted = 0;
  for (const person of people) {
    if (inserted >= budgetRemaining) break;
    const org = (person.organization && typeof person.organization === 'object'
      ? (person.organization as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    const rawEmail = typeof person.email === 'string' ? person.email : '';
    const email = rawEmail && !rawEmail.includes('not_unlocked') ? rawEmail : '';
    const domain = String(org.primary_domain || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
    if (!email && !domain) continue;
    const firstName = typeof person.first_name === 'string' ? person.first_name : '';
    const lastName = typeof person.last_name === 'string' ? person.last_name : '';
    const name = [firstName, lastName].filter(Boolean).join(' ');
    const personTitle = typeof person.title === 'string' ? person.title : '';

    const insertedId = await withOrgClient(orgId, async (client) => {
      const res = await client.query(
        `INSERT INTO growth_scout_leads (org_id, contact_email, company_domain, contact_name, title)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, contact_email, company_domain) DO NOTHING
         RETURNING id`,
        [orgId, email, domain, name, personTitle],
      );
      return res.rows[0]?.id as string | undefined;
    }).catch(() => undefined);
    if (!insertedId) continue;

    const crmResult = await executeAutonomousToolAction({
      tool: 'hubspot',
      action: 'create_crm_contact',
      payload: { email, firstname: firstName, lastname: lastName, company: org.name || domain },
      orgId,
      employeeRole: 'marketing',
      source: 'sweep',
    }).catch(() => null);
    const crmSynced = crmResult?.status === 'executed';

    if (!crmSynced) {
      await createOpportunityActivity({
        orgId,
        candidate: {
          companyName: String(org.name || domain || name || 'unknown'),
          domain: domain || String(org.name || name || 'unknown').toLowerCase().replace(/\s+/g, ''),
          industry: typeof org.industry === 'string' ? org.industry : industry,
          headcount: typeof org.estimated_num_employees === 'number' ? org.estimated_num_employees : undefined,
          title: personTitle || undefined,
          contactName: name || undefined,
          contactEmail: email || undefined,
          linkedin: typeof person.linkedin_url === 'string' ? person.linkedin_url : undefined,
          activeSignals: [
            { type: 'other', summary: 'Sourced by Market Scout (Apollo)', timestamp },
          ],
          fit: 0.5,
          now: 0.3,
          score: 55,
        },
        businessKey: `${params.businessKey}:scout-opp:${domain || email}`,
      });
    }

    await withOrgClient(orgId, async (client) => {
      await client.query(`UPDATE growth_scout_leads SET crm_synced = $1 WHERE id = $2`, [crmSynced, insertedId]);
    }).catch(() => undefined);

    inserted += 1;
  }

  const out = { searched, found: people.length, inserted, dailyCap };
  await writeIdempotent(orgId, key, out);
  return out;
}

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com', 'proton.me', 'protonmail.com',
]);

function externalAttendeeDomain(attendees: string[]): { email: string; domain: string } | null {
  for (const email of attendees) {
    const at = email.indexOf('@');
    if (at < 0) continue;
    const domain = email.slice(at + 1).toLowerCase();
    if (!domain || PERSONAL_EMAIL_DOMAINS.has(domain)) continue;
    return { email, domain };
  }
  return null;
}

/**
 * GE-07 Pre-Meeting Account Dossier — scans upcoming Google Calendar events
 * for a non-personal attendee domain, compiles a 1-page brief from a web
 * search + extract on that company, and posts it to Slack. Each calendar
 * event is only processed once (growth_meeting_dossiers dedup ledger).
 */
export async function compileMeetingDossiersActivity(params: {
  orgId: string;
  businessKey: string;
}): Promise<{ scanned: number; compiled: number; posted: number }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'compileMeetingDossiers', params.businessKey);
  const cached = await readIdempotent<{ scanned: number; compiled: number; posted: number }>(orgId, key);
  if (cached) return cached;

  const timestamp = new Date().toISOString();
  const listResult = await executeAutonomousToolAction({
    tool: 'google-calendar',
    action: 'list_events',
    payload: {},
    orgId,
    employeeRole: 'marketing',
    source: 'sweep',
  }).catch(() => null);

  const events = listResult?.status === 'executed' && listResult.data && typeof listResult.data === 'object'
    ? ((listResult.data as { events?: Array<Record<string, unknown>> }).events || [])
    : [];

  let compiled = 0;
  let posted = 0;
  for (const event of events) {
    const eventId = typeof event.id === 'string' ? event.id : '';
    if (!eventId) continue;
    const attendees = Array.isArray(event.attendees)
      ? (event.attendees as unknown[]).filter((a): a is string => typeof a === 'string')
      : [];
    const external = externalAttendeeDomain(attendees);
    if (!external) continue;

    const already = await withOrgClient(orgId, async (client) => {
      const res = await client.query(
        `SELECT 1 FROM growth_meeting_dossiers WHERE org_id = $1 AND calendar_event_id = $2`,
        [orgId, eventId],
      );
      return res.rows.length > 0;
    }).catch(() => false);
    if (already) continue;

    const searchResult = await executeAutonomousToolAction({
      tool: 'web_search',
      action: 'search',
      payload: { query: `${external.domain} company overview` },
      orgId,
      employeeRole: 'marketing',
      source: 'sweep',
    }).catch(() => null);
    const hits = searchResult?.status === 'executed' && searchResult.data && typeof searchResult.data === 'object'
      ? ((searchResult.data as { results?: Array<{ title?: string; url?: string; snippet?: string }> }).results || [])
      : [];

    let overview = hits.map((h) => h.snippet || h.title).filter(Boolean).slice(0, 3).join(' ');
    const topUrl = hits[0]?.url;
    if (topUrl) {
      const extractResult = await executeAutonomousToolAction({
        tool: 'web_extract',
        action: 'extract',
        payload: { url: topUrl },
        orgId,
        employeeRole: 'marketing',
        source: 'sweep',
      }).catch(() => null);
      const content = extractResult?.status === 'executed' && extractResult.data && typeof extractResult.data === 'object'
        ? String((extractResult.data as { content?: string }).content || '')
        : '';
      if (content) overview = content.slice(0, 800);
    }

    const dossier = {
      meetingTitle: typeof event.summary === 'string' ? event.summary : 'Meeting',
      startTime: typeof event.start === 'string' ? event.start : null,
      attendeeEmail: external.email,
      companyDomain: external.domain,
      companyOverview: overview || `No public overview found for ${external.domain}.`,
      generatedAt: timestamp,
    };
    compiled += 1;

    const slackText =
      `*Pre-meeting dossier — ${dossier.meetingTitle}*\n` +
      `Attendee: ${dossier.attendeeEmail} (${dossier.companyDomain})\n` +
      `When: ${dossier.startTime || 'unscheduled'}\n\n` +
      dossier.companyOverview.slice(0, 1500);
    const slackResult = await executeAutonomousToolAction({
      tool: 'slack',
      action: 'send_channel_message',
      payload: { message: slackText },
      orgId,
      employeeRole: 'marketing',
      source: 'sweep',
    }).catch(() => null);
    const postedOk = slackResult?.status === 'executed';
    if (postedOk) posted += 1;

    await withOrgClient(orgId, async (client) => {
      await client.query(
        `INSERT INTO growth_meeting_dossiers
           (org_id, calendar_event_id, attendee_email, company_domain, posted_to_slack, dossier)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, calendar_event_id) DO NOTHING`,
        [orgId, eventId, external.email, external.domain, postedOk, JSON.stringify(dossier)],
      );
    }).catch(() => undefined);
  }

  const out = { scanned: events.length, compiled, posted };
  await writeIdempotent(orgId, key, out);
  return out;
}

function senderEmailFromHeader(from: string): string {
  const angle = from.match(/<([^>]+)>/);
  const raw = angle ? angle[1] : from;
  return raw.trim().toLowerCase();
}

/**
 * GE-09 Smart Reply Sorter — classifies inbound Gmail replies from tracked
 * growth prospects (Interested / Objection / OOO / Unsubscribe), updates the
 * matching growth_opportunity's CRM stage, and alerts the rep on Slack when
 * a reply signals genuine interest. Each Gmail message is only acted on
 * once (growth_reply_classifications dedup ledger).
 */
export async function classifyInboundRepliesActivity(params: {
  orgId: string;
  businessKey: string;
}): Promise<{ scanned: number; classified: Record<string, number> }> {
  const orgId = requireOrgId(params.orgId);
  const key = sideEffectKey(orgId, 'classifyInboundReplies', params.businessKey);
  const cached = await readIdempotent<{ scanned: number; classified: Record<string, number> }>(orgId, key);
  if (cached) return cached;

  const timestamp = new Date().toISOString();
  const fetchResult = await executeAutonomousToolAction({
    tool: 'gmail',
    action: 'fetch_latest_emails',
    payload: { count: 20 },
    orgId,
    employeeRole: 'marketing',
    source: 'sweep',
  }).catch(() => null);

  const emails = fetchResult?.status === 'executed' && fetchResult.data && typeof fetchResult.data === 'object'
    ? ((fetchResult.data as { emails?: Array<Record<string, unknown>> }).emails || [])
    : [];

  const tally: Record<string, number> = {};
  for (const email of emails) {
    const messageId = typeof email.id === 'string' ? email.id : '';
    if (!messageId) continue;
    const fromEmail = senderEmailFromHeader(String(email.from || ''));
    if (!fromEmail) continue;

    const already = await withOrgClient(orgId, async (client) => {
      const res = await client.query(
        `SELECT 1 FROM growth_reply_classifications WHERE org_id = $1 AND gmail_message_id = $2`,
        [orgId, messageId],
      );
      return res.rows.length > 0;
    }).catch(() => false);
    if (already) continue;

    const matched = await withOrgClient(orgId, async (client) => {
      const res = await client.query<{ id: string }>(
        `SELECT id FROM work_items
           WHERE org_id = $1 AND type = 'growth_opportunity'
             AND lower(metadata->'card'->'targetContact'->>'email') = $2
           ORDER BY updated_at DESC
           LIMIT 1`,
        [orgId, fromEmail],
      );
      return res.rows[0]?.id as string | undefined;
    }).catch(() => undefined);
    if (!matched) continue;

    const classification = classifyReply(`${email.subject || ''}\n${email.body || email.snippet || ''}`);
    tally[classification] = (tally[classification] || 0) + 1;

    if (classification === 'unsubscribe') {
      await withOrgClient(orgId, async (client) => {
        await client.query(
          `UPDATE work_items SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
          [matched, orgId],
        );
        await client.query(
          `INSERT INTO org_preferences (org_id, rules, suppressions, updated_at)
           VALUES ($1, '[]'::jsonb, $2::jsonb, NOW())
           ON CONFLICT (org_id) DO UPDATE SET
             suppressions = COALESCE(org_preferences.suppressions, '[]'::jsonb) || EXCLUDED.suppressions,
             updated_at = NOW()`,
          [orgId, JSON.stringify([{ reason: 'unsubscribe', workItemId: matched, patternKey: fromEmail, dimension: 'channel' }])],
        );
      }).catch(() => undefined);
      await recordGrowthRoiActivity({
        orgId,
        opportunityWorkItemId: matched,
        stage: 'lost',
        businessKey: `${params.businessKey}:roi:${matched}:unsubscribe`,
      });
    } else if (classification === 'interested') {
      await recordGrowthRoiActivity({
        orgId,
        opportunityWorkItemId: matched,
        stage: 'conversation',
        businessKey: `${params.businessKey}:roi:${matched}:interested`,
      });
      await executeAutonomousToolAction({
        tool: 'slack',
        action: 'send_channel_message',
        payload: {
          message: `Hot lead: ${fromEmail} replied *interested* to outreach. Reply now: "${String(email.subject || '')}"`,
        },
        orgId,
        employeeRole: 'marketing',
        source: 'sweep',
      }).catch(() => null);
    }

    await withOrgClient(orgId, async (client) => {
      await client.query(
        `INSERT INTO growth_reply_classifications (org_id, gmail_message_id, from_email, work_item_id, classification)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, gmail_message_id) DO NOTHING`,
        [orgId, messageId, fromEmail, matched, classification],
      );
    }).catch(() => undefined);
  }

  const out = { scanned: emails.length, classified: tally };
  await writeIdempotent(orgId, key, out);
  return out;
}

export async function runGrowthWatchActivity(params: {
  orgId: string;
  businessKey: string;
}): Promise<{ idle: boolean; signals: number; opportunities: number }> {
  const orgId = requireOrgId(params.orgId);
  const icp = await loadOrBuildIcpActivity({ orgId, maxAgeDays: 7, businessKey: `${params.businessKey}:icp` });
  const polled = await pollSignalsActivity({ orgId, businessKey: `${params.businessKey}:signals` });
  await persistSignalsActivity({ orgId, signals: polled.signals, businessKey: `${params.businessKey}:persist` });
  const prefs = await loadPreferencesActivity({ orgId, businessKey: `${params.businessKey}:prefs` });
  await synthesizePreferencesActivity({ orgId, businessKey: `${params.businessKey}:synth` });
  const lookalikes = await searchLookalikeCandidatesActivity({
    orgId,
    icp: icp.icp,
    businessKey: `${params.businessKey}:lookalike`,
  });
  const ranked = await rankCandidatesActivity({
    orgId,
    icp: icp.icp,
    signals: polled.signals,
    prefs: prefs.rules,
    externalCandidates: lookalikes.candidates,
    businessKey: `${params.businessKey}:rank`,
  });
  let opportunities = 0;
  for (const c of ranked.ranked.filter((x) => x.score >= 70 && x.activeSignals.length > 0)) {
    const created = await createOpportunityActivity({
      orgId,
      candidate: c,
      businessKey: `${params.businessKey}:opp:${c.domain}`,
    });
    if (created.created) {
      opportunities += 1;
      await recordGrowthRoiActivity({
        orgId,
        opportunityWorkItemId: created.workItemId,
        stage: 'created',
        businessKey: `${params.businessKey}:roi:${created.workItemId}`,
      });
    }
  }
  return { idle: polled.signals.length === 0 && opportunities === 0, signals: polled.signals.length, opportunities };
}
