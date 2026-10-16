import type { PoolClient } from 'pg';
import { getTemporalClient } from '@darex/workflows/dist/workflow-client';
import { startSweepsForOrg } from '@darex/workflows/dist/periodic-registry';

import { DEFAULT_AUTONOMY_SEED } from '@darex/workflows/dist/cold-start';
import { findUnansweredThreads, persistFirstObservation } from '@/lib/onboarding-observation-query';

/**
 * P1-DB-5 — seed default autonomy rules when an org is created.
 * No-ops if migration 023 has not been applied yet.
 */
export async function seedDefaultAutonomyRules(client: PoolClient, orgId: string): Promise<number> {
  try {
    let inserted = 0;
    for (const row of DEFAULT_AUTONOMY_SEED) {
      const res = await client.query(
        `INSERT INTO employee_autonomy_rules
           (org_id, action_type, autonomy_tier, reversibility, requires_human_approval)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [orgId, row.action_type, row.autonomy_tier, row.reversibility, row.requires_human_approval],
      );
      inserted += res.rowCount ?? 0;
    }
    return inserted;
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42P01') return 0;
    throw err;
  }
}

/** Gap 21 — default spend ceilings. No-ops if 029 is not applied. */
export async function seedOrgCostCeiling(client: PoolClient, orgId: string): Promise<number> {
  try {
    const res = await client.query(
      `INSERT INTO org_cost_ceilings (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`,
      [orgId],
    );
    return res.rowCount ?? 0;
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42P01') return 0;
    throw err;
  }
}

/**
 * 16 §5 — new orgs get every periodic sweep at provisioning, not next deploy.
 * Uses the worker's PERIODIC_SWEEPS list (startSweepsForOrg) so provisioning
 * and worker boot can never start different sweep sets (OPS-B05). Also the
 * restart path after an org is reactivated: ended sweeps start again.
 */
export function kickPeriodicSweeps(orgId: string): void {
  void (async () => {
    const client = await getTemporalClient();
    if (!client) return;
    await startSweepsForOrg(client, orgId);
  })().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[provision] periodic sweeps for ${orgId}: ${message}`);
  });
}

export const DEFAULT_EMPLOYEE_ROSTER = [
  {
    name: 'Customer',
    role: 'Customer Resolution',
    persona: '24/7 Customer Support and Resolution Manager. Resolves customer needs end-to-end, not just replies. Handles order inquiries, returns/refunds within policy (approval-gated), CRM/ticket lookup, calendar scheduling, and follow-ups. Prefer cognee_memory_remember to teach the brain durable policy facts. Hand payment links/invoices to Finance, spreadsheet reconciliation to Operations, and prospecting to Growth/Sales.',
    tool_allowlist: ['gmail', 'whatsapp', 'google-calendar', 'stripe', 'hubspot', 'zendesk', 'intercom', 'customer-ops', 'database_query'],
    status: 'active',
  },
  {
    name: 'Operations',
    role: 'Operations',
    persona: 'Operations and triage manager. Reconciles cross-system records, resolves data discrepancies, dedups CRM contacts, audits meeting prep, and coordinates team briefs.',
    tool_allowlist: ['hubspot', 'database_query', 'google-calendar', 'google-sheets', 'slack', 'gmail', 'operations', 're'],
    status: 'active',
  },
  {
    name: 'Growth',
    role: 'Growth',
    persona: 'B2B Growth & Pipeline strategist. Identifies high-intent website visitors, scores lookalikes, tracks buying signals, and drafts targeted executive outreach.',
    tool_allowlist: ['hubspot', 'web_search', 'web_extract', 'apollo', 'gmail', 'slack', 'growth'],
    status: 'active',
  },
  {
    name: 'Sarah',
    role: 'Sales & Lead Gen',
    persona: 'Enthusiastic and persuasive sales specialist focused on lead qualification, product demos, and pricing negotiations.',
    tool_allowlist: ['gmail', 'whatsapp', 'hubspot', 'salesforce', 'zoho-crm', 'apollo', 'linkedin', 'google-calendar', 're'],
    status: 'active',
  },
  {
    name: 'Emma',
    role: 'Customer Support',
    persona: 'Empathetic front-line support agent for FAQs, inbox triage, and calendar scheduling over Gmail, WhatsApp, and Google Calendar. Does not process refunds, CRM/payments lookups, or Zendesk/Intercom tickets — hand those to Customer (Customer Resolution). Prefer cognee_memory_remember when teaching durable FAQ answers to the brain.',
    tool_allowlist: ['gmail', 'whatsapp', 'google-calendar', 'customer-ops'],
    status: 'active',
  },
  {
    name: 'Marcus',
    role: 'Marketing & Analytics',
    persona: 'Data-driven marketing strategist monitoring campaign performance, ad conversions, customer feedback, and market trends.',
    tool_allowlist: [
      'meta-ads',
      'google-ads',
      'gmail',
      'google-analytics',
      'google-search-console',
      'google-business-profile',
    ],
    status: 'active',
  },
  {
    name: 'Research',
    role: 'Research',
    persona: JSON.stringify({
      text: 'Read-heavy researcher. Cite web and Drive/Notion docs. Never invent sources or listings. Hand pay, refund, or reconcile asks to Finance, Customer, or Operations.',
      rosterKey: 'research',
      confirmClasses: [],
    }),
    tool_allowlist: ['web_search', 'web_extract', 'google-drive', 'notion'],
    status: 'active',
  },
  {
    name: 'Executive',
    role: 'Executive',
    persona: JSON.stringify({
      text: 'Cross-domain coordinator. Deliver the daily brief from real work items, summarize org status, and hand specialist work to the right employee. Never invent sources. Never send, pay, or run ads.',
      rosterKey: 'executive',
      confirmClasses: [],
    }),
    tool_allowlist: [
      'web_search',
      'database_query',
      'cognee',
      'daily_brief',
      'ask_numbers',
      'research_topic',
      'improvement_note',
      'gmail',
      'google-calendar',
      'google-drive',
      'google-docs',
      'google-sheets',
      'google-slides',
      'slack',
    ],
    status: 'active',
  },
  {
    name: 'Finance',
    role: 'Finance',
    persona: JSON.stringify({
      text: 'Invoices and payment links. Always confirm before pay. Never create a charge or payout without owner confirmation. Hand refunds to Customer.',
      rosterKey: 'finance',
      confirmClasses: ['pay'],
    }),
    tool_allowlist: ['stripe', 'razorpay', 'quickbooks', 'billing_usage'],
    status: 'active',
  },
];

/**
 * Ensure org is in cold-start observe mode (autonomy_stage 0) and, when the
 * inbox already has unanswered threads, persist the first real observation.
 * Never invents metrics — empty inbox yields a real "watching" observation only
 * when no observation row exists yet.
 */
export async function ensureEmployeeColdStart(client: PoolClient, orgId: string): Promise<void> {
  try {
    await client.query(
      `INSERT INTO org_runtime_controls (org_id, kill_switch, autonomy_stage, updated_at)
       VALUES ($1, FALSE, 0, NOW())
       ON CONFLICT (org_id) DO NOTHING`,
      [orgId],
    );
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42P01') return;
    throw err;
  }

  try {
    const existing = await client.query(
      `SELECT id FROM org_first_observations WHERE org_id = $1 LIMIT 1`,
      [orgId],
    );
    if (existing.rows.length > 0) return;

    const threads = await findUnansweredThreads(client, orgId);
    await persistFirstObservation(client, orgId, threads);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === '42P01') return;
    throw err;
  }
}

/**
 * Seed default AI employees for a newly created organization.
 * Skips if the org already has any employees in `ai_employees`.
 * All roster inserts run in one transaction so a mid-loop failure leaves no orphans.
 */
export async function seedDefaultEmployees(client: PoolClient, orgId: string): Promise<number> {
  try {
    const existing = await client.query(
      `SELECT COUNT(*)::text AS count FROM ai_employees WHERE org_id = $1`,
      [orgId]
    );
    if (parseInt(existing.rows[0]?.count || '0', 10) > 0) {
      return 0;
    }

    // If org already marked seeded (roster intentionally emptied), do not reseed.
    try {
      const seededFlag = await client.query<{ employees_seeded: boolean | null }>(
        `SELECT employees_seeded FROM orgs WHERE id = $1`,
        [orgId],
      );
      if (seededFlag.rows[0]?.employees_seeded === true) {
        return 0;
      }
    } catch (err: unknown) {
      // Column may not exist until migration 038 — fall through and seed once.
      if ((err as { code?: string })?.code !== '42703') throw err;
    }

    await client.query('BEGIN');
    try {
      let inserted = 0;
      for (const emp of DEFAULT_EMPLOYEE_ROSTER) {
        const personaVal =
          typeof emp.persona === 'string'
            ? (emp.persona.trim().startsWith('{') ? emp.persona : JSON.stringify(emp.persona))
            : JSON.stringify(emp.persona);
        await client.query(
          `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, graph_id, status)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
           ON CONFLICT DO NOTHING`,
          [
            orgId,
            emp.name,
            emp.role,
            personaVal,
            emp.tool_allowlist,
            `default-${emp.name.toLowerCase()}`,
            emp.status,
          ]
        );
        inserted += 1;
      }

      try {
        await client.query(
          `UPDATE orgs SET employees_seeded = TRUE, updated_at = NOW() WHERE id = $1`,
          [orgId],
        );
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== '42703') throw err;
      }

      await seedDefaultAutonomyRules(client, orgId);
      await ensureEmployeeColdStart(client, orgId);
      await client.query('COMMIT');
      return inserted;
    } catch (inner: unknown) {
      await client.query('ROLLBACK');
      throw inner;
    }
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42P01') return 0;
    throw err;
  }
}

/**
 * Insert a custom AI employee and seed org-level autonomy rules in one transaction.
 * Rolls back the employee row if autonomy seeding fails mid-request.
 */
export async function provisionCustomEmployee(
  client: PoolClient,
  orgId: string,
  input: {
    name: string;
    role: string;
    personaJson: string;
    toolAllowlist: string[];
    status: 'active' | 'paused';
    graphId: string;
  },
): Promise<Record<string, unknown>> {
  await client.query('BEGIN');
  try {
    const res = await client.query(
      `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, graph_id, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING id, name, role, persona, tool_allowlist, graph_id, status, created_at, updated_at`,
      [
        orgId,
        input.name,
        input.role,
        input.personaJson,
        input.toolAllowlist,
        input.graphId,
        input.status,
      ],
    );
    const employee = res.rows[0] as Record<string, unknown>;

    // Seed org autonomy matrix if empty — custom hires must not bypass gating.
    await seedDefaultAutonomyRules(client, orgId);
    await ensureEmployeeColdStart(client, orgId);

    try {
      await client.query(
        `UPDATE orgs SET employees_seeded = TRUE, updated_at = NOW() WHERE id = $1`,
        [orgId],
      );
    } catch (err: unknown) {
      if ((err as { code?: string })?.code !== '42703') throw err;
    }

    await client.query('COMMIT');
    return employee;
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    throw err;
  }
}
