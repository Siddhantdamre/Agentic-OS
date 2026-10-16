import { NextResponse } from 'next/server';
import { getOrgScopedClient } from '@/lib/db';
import {
  clientIpFromRequest,
  crossesVisitFrequencyGate,
  findDepartmentHead,
  hashVisitorIp,
  isPricingPath,
  markVisitorLeadCreated,
  revealCompanyFromIp,
  upsertVisitorIntent,
} from '@/lib/visitor-enrich';
import { denyWebhookIfLimited } from '@/lib/rate-limit';
import {
  ignoreBodyOrgId,
  orgHasInstalledPack,
  widgetForbidden,
  requireWidgetOrg,
  widgetPreflight,
  withWidgetCors,
} from '../_lib';
import { jsonBodyOrEmpty } from '@/lib/safe-json';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: Request) {
  return widgetPreflight(request);
}

/**
 * POST /api/widget/intent
 * Public embed ping. Tenant is the site key — body org_id is ignored.
 */
export async function POST(request: Request) {
  const auth = await requireWidgetOrg(request);
  if (!auth.ok) return auth.response;

  const limited = denyWebhookIfLimited(auth.orgId);
  if (limited) return withWidgetCors(request, limited, auth.allowedOrigins);

  if (!(await orgHasInstalledPack(auth.orgId))) {
    return withWidgetCors(
      request,
      widgetForbidden('Widget is deny-all until a pack is installed.'),
      auth.allowedOrigins
    );
  }

  let body: Record<string, unknown> = {};
  body = await jsonBodyOrEmpty<Record<string, unknown>>(request);
  ignoreBodyOrgId(body);

  const path =
    (typeof body.path === 'string' && body.path) ||
    (typeof body.href === 'string' && body.href) ||
    '';
  const visitorId =
    typeof body.visitorId === 'string' ? body.visitorId.trim().slice(0, 80) : null;
  const ip = clientIpFromRequest(request);
  const ipHash = hashVisitorIp(ip || 'unknown');
  const pricing = isPricingPath(path);

  let companyName: string | null = null;
  let companyDomain: string | null = null;
  let reveal: Awaited<ReturnType<typeof revealCompanyFromIp>>;
  if (ip) {
    reveal = await revealCompanyFromIp(ip);
    if (reveal.available) {
      companyName = reveal.companyName || null;
      companyDomain = reveal.companyDomain || null;
    }
  } else {
    reveal = {
      available: false,
      connected: Boolean(process.env.IP_REVEAL_API_URL && process.env.IP_REVEAL_API_KEY),
      reason: 'missing_ip',
    };
  }

  const enrichmentStatus = reveal.available
    ? 'resolved'
    : reveal.reason === 'unavailable'
      ? 'unavailable'
      : reveal.connected
        ? 'error'
        : 'pending';

  const { client } = await getOrgScopedClient(auth.orgId);
  try {
    const stored = await upsertVisitorIntent(client, {
      orgId: auth.orgId,
      ipHash,
      visitorId,
      path: path || null,
      isPricing: pricing,
      companyName,
      companyDomain,
      enrichmentStatus,
      enrichmentSource: reveal.available ? 'ip_reveal' : 'none',
    });

    let leadCreated = false;
    if (
      pricing &&
      stored.ok &&
      companyDomain &&
      crossesVisitFrequencyGate(stored.pricingPageVisits, stored.leadCreatedAt)
    ) {
      const head = await findDepartmentHead(companyDomain);
      try {
        const existing = await client.query(
          `SELECT id FROM work_items
             WHERE org_id = $1 AND type = 'growth_opportunity'
               AND metadata->'card'->>'companyDomain' = $2
               AND status IN ('open', 'needs_attention', 'waiting_approval')
             LIMIT 1`,
          [auth.orgId, companyDomain]
        );
        if (!existing.rows[0]) {
          const contact = head.contact;
          const card = {
            companyName: companyName || companyDomain,
            companyDomain,
            icpScore: 65,
            whyThisCompany: `${companyName || companyDomain} visited your pricing page ${stored.pricingPageVisits}+ times in 24 hours — active buying intent.`,
            targetContact: {
              name: contact?.name || 'decision maker',
              title: contact?.title || 'VP Sales',
              email: contact?.email,
              linkedin: contact?.linkedin,
            },
            whyThisPerson: contact?.name
              ? `${contact.name} (${contact.title || 'decision maker'}) owns the buying decision at ${companyName || companyDomain}.`
              : `Department-head discovery unavailable — no Apollo match for ${companyDomain}.`,
            buyingSignals: [
              {
                type: 'intent',
                summary: `${stored.pricingPageVisits} pricing-page visits in 24h`,
                timestamp: new Date().toISOString(),
              },
            ],
            whyNow: `Repeated pricing-page visits from ${companyName || companyDomain} in the last 24 hours.`,
            draftedMessage: {
              subject: `${companyName || companyDomain} — saw you checking out pricing`,
              body: `Noticed folks from ${companyName || companyDomain} looking at pricing a couple of times — happy to answer any questions.`,
            },
          };
          await client.query(
            `INSERT INTO work_items (org_id, type, status, channel, priority, metadata)
             VALUES ($1, 'growth_opportunity', 'needs_attention', 'ask_ai', 'normal', $2)`,
            [auth.orgId, JSON.stringify({ card, recommendedAction: 'send_outreach' })]
          );
          leadCreated = true;
        }
        await markVisitorLeadCreated(client, auth.orgId, ipHash);
      } catch (err: unknown) {
        console.error('POST /api/widget/intent lead-creation Error:', err);
      }
    }

    return withWidgetCors(
      request,
      NextResponse.json({
        ok: true,
        isPricing: pricing,
        stored: stored.ok,
        missingTable: stored.missingTable,
        leadCreated,
        reveal: {
          available: reveal.available,
          connected: reveal.connected,
          reason: reveal.reason || null,
          companyName,
          companyDomain,
        },
      }),
      auth.allowedOrigins
    );
  } catch (err: unknown) {
    console.error('POST /api/widget/intent Error:', err);
    return withWidgetCors(
      request,
      NextResponse.json({ error: 'Internal Server Error' }, { status: 500 }),
      auth.allowedOrigins
    );
  } finally {
    client.release();
  }
}
