#!/usr/bin/env node
'use strict';
/**
 * SHIPPED, TESTED, AND NEVER ONCE USED.
 *
 * Five times now this codebase has produced the same defect: a capability is
 * built, its suite passes, and it is unreachable in production. Operator edit
 * learning, knowledge gaps, the outcome ledger, approvals, quiet leads — and
 * then cross-channel identity, which had a schema, a resolver, an erasure
 * function, 14 passing assertions, and ZERO rows, because the backfill was
 * preview-by-default and nobody ever passed --write.
 *
 * Every one of those suites passed the entire time. They pass because each
 * creates its own fixtures, exercises the layer, and tears them down. Not one
 * of them ever asked the only question that would have caught it:
 *
 *     has this feature EVER produced a row on this deployment?
 *
 * That is what this checks. It is deliberately the blunt instrument, because
 * the subtle instruments all passed.
 *
 * ── WHY IT DOES NOT JUST FAIL ON EVERY EMPTY TABLE ────────────────────────
 * A blank install has zero rows everywhere and is not broken. A vertical pack
 * nobody installed has zero rows and is not broken. So each capability
 * declares WHEN it should be expected to have produced something:
 *
 *   every-turn   a row must appear whenever its trigger happens. Zero rows
 *                with triggers present means the wiring is dead -> FAIL.
 *   conditional  fires only in circumstances that may not have arisen. Zero
 *                is reported, never failed, but it must say what it waits for.
 *   human        needs a person to act. Cannot be forced; reported only.
 *   blocked      has a named external blocker (credit, an API key). Reported,
 *                and the blocker must be named or the entry is invalid.
 *
 * ── THE PART THAT CATCHES THE NEXT ONE ────────────────────────────────────
 * The registry must also be COMPLETE. Every table in the database is either a
 * declared capability or an explicitly classified non-capability. Ship a new
 * table and this fails until somebody writes down whether it should ever have
 * rows — which is the exact question nobody asked five times running.
 *
 * Usage: node infra/scripts/check-dormant-capability.js [--verbose]
 * Exit:  0 = nothing dead, 1 = a wired capability has never produced a row
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const VERBOSE = process.argv.includes('--verbose');

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

// ── The capabilities, and what each one waits for ──────────────────────────
// `trigger` is a COUNT query. When it returns > 0 the capability had its
// chance; if the table is still empty, an 'every-turn' capability is dead.
const CAPABILITIES = [
  {
    name: 'conversations land',
    table: 'conversations',
    expectation: 'every-turn',
    trigger: 'SELECT COUNT(*) FROM orgs',
    note: 'an inbound message becomes a conversation',
  },
  {
    name: 'the agent acts',
    table: 'agent_actions',
    expectation: 'every-turn',
    trigger: 'SELECT COUNT(*) FROM conversations',
    note: 'every turn records what the agent did',
  },
  {
    name: 'memory write-back',
    table: 'org_memory',
    expectation: 'every-turn',
    trigger: 'SELECT COUNT(*) FROM conversations',
    note: 'the agent remembers what it was told',
  },
  {
    name: 'outcome ledger',
    table: 'outcome_events',
    expectation: 'every-turn',
    trigger: 'SELECT COUNT(*) FROM agent_actions',
    note: 'what the work was worth, as arithmetic',
  },
  {
    name: 'cross-channel identity',
    table: 'contact_persons',
    expectation: 'every-turn',
    trigger: 'SELECT COUNT(*) FROM conversations',
    // THE ONE THIS CHECK WAS BUILT FOR. It was 0 against 719 conversations.
    note: 'every conversation resolves to a human',
  },
  {
    name: 'identity handles',
    table: 'contact_identities',
    expectation: 'every-turn',
    trigger: 'SELECT COUNT(*) FROM contact_persons',
    note: 'each person keeps the spellings they arrived under',
  },
  {
    name: 'knowledge gaps',
    table: 'knowledge_gaps',
    expectation: 'conditional',
    trigger: 'SELECT COUNT(*) FROM agent_actions',
    note: 'waits for a question the agent could not answer',
  },
  {
    name: 'quiet leads',
    table: 'lead_followups',
    expectation: 'conditional',
    trigger: 'SELECT COUNT(*) FROM conversations',
    note: 'waits for a lead to go quiet inside business hours',
  },
  {
    name: 'task supervision (the trio)',
    table: 'task_supervision',
    expectation: 'every-turn',
    // Only work items finished AFTER the capability shipped could have a row.
    // Counting all 648 completed items would fail this forever on history that
    // predates the feature, which is a false alarm, not a finding.
    trigger: `SELECT COUNT(*) FROM work_items w
              WHERE w.status = 'done'
                AND w.created_at > (SELECT applied_at FROM _migrations
                                     WHERE filename LIKE '042%' LIMIT 1)`,
    note: 'every finished task records what all three roles did',
  },
  {
    name: 'per-tenant budget metering',
    table: 'org_llm_usage_daily',
    expectation: 'blocked',
    blocker: 'OpenRouter balance exhausted — no paid call has been dispatched, '
      + 'so there is no usage to meter',
    trigger: 'SELECT COUNT(*) FROM agent_actions',
    note: 'tokens spent, per workspace, per day',
  },
  {
    name: 'per-tenant budget limits',
    table: 'org_llm_budget',
    expectation: 'conditional',
    trigger: 'SELECT COUNT(*) FROM orgs',
    note: 'waits for an operator to set a cap; absent means unlimited, by design',
  },
  {
    name: 'operator edit learning',
    table: 'reply_edits',
    expectation: 'human',
    trigger: 'SELECT COUNT(*) FROM agent_actions',
    note: 'waits for an operator to correct a reply',
  },
  {
    name: 'approvals',
    table: 'approval_requests',
    expectation: 'human',
    trigger: 'SELECT COUNT(*) FROM agent_actions',
    note: 'waits for the agent to attempt something that needs a person; '
      + 'no default role holds pay or sign, so this may correctly stay empty',
  },
  {
    name: 'commitment ledger',
    table: 'commitments',
    expectation: 'conditional',
    trigger: 'SELECT COUNT(*) FROM agent_actions',
    note: 'waits for a reply that contains a promise',
  },
  {
    name: 'trigger engine',
    table: 'trigger_dispatches',
    expectation: 'conditional',
    trigger: 'SELECT COUNT(*) FROM org_automation',
    note: 'waits for a scheduled automation to come due',
  },
  {
    name: 'earned autonomy',
    table: 'action_outcomes',
    expectation: 'conditional',
    trigger: 'SELECT COUNT(*) FROM org_action_autonomy',
    note: 'waits for an action whose outcome moves the trust level',
  },
  {
    // Filed as "platform bookkeeping" until someone asked about the multi-agent
    // system. agent_plans is the CREW's output — the plan naming which
    // specialists to spawn. Shelving it as bookkeeping made this check blind to
    // the largest dormant capability in the product, which is the second time a
    // misclassification here hid exactly what the check exists to find.
    name: 'multi-agent crew',
    table: 'agent_plans',
    expectation: 'conditional',
    trigger: 'SELECT COUNT(*) FROM ai_employees',
    note: 'waits for someone to spawn a crew from the Employees page; the '
      + 'child-workflow fan-out, the cap and the synthesis exist but have '
      + 'never executed once',
  },
  {
    // Filed here rather than under "tenant configuration", which is where it sat
    // and why this check never looked at it. It is a CONTROL: it promises that
    // nothing the agent writes reaches a customer. It was empty while the agent
    // auto-replied on four channels.
    name: 'shadow mode',
    table: 'org_shadow_mode',
    expectation: 'conditional',
    trigger: 'SELECT COUNT(*) FROM orgs',
    note: 'waits for an operator to switch it on; the switch is enforced at the send',
  },
  {
    name: 'audit trail',
    table: 'audit_events',
    expectation: 'every-turn',
    trigger: 'SELECT COUNT(*) FROM orgs',
    note: 'privileged actions are written down',
  },
  {
    name: 'erasure requests',
    table: 'erasure_requests',
    expectation: 'human',
    trigger: 'SELECT COUNT(*) FROM contact_persons',
    note: 'waits for someone to ask to be forgotten',
  },
];

// ── Everything else, classified so the registry stays complete ─────────────
// A table here is asserting "this should not be read as a dormant capability",
// and says why. Adding a table without classifying it fails the check.
const NON_CAPABILITY = {
  'tenant configuration — rows appear when a workspace is set up, and their absence is a setup state, not a dead feature': [
    'orgs', 'users', 'ai_employees', 'channels', 'connector_defs', 'org_connectors',
    'org_onboarding', 'org_automation', 'org_retention_policy', 'org_packs',
    'org_sql_connections', 'widget_embed_tokens', 'org_invites', 'chatwoot_inbox_map',
    'org_action_autonomy', 'org_playbook_promotions', 'billing_meters',
  ],
  'platform bookkeeping — not a customer-facing capability': [
    '_migrations', 'idempotency_keys', 'work_events', 'work_items', 'messages',
    'channel_logs', 'sync_cursors', 'provider_spend_snapshots', 'password_reset_tokens',
  ],
  'vertical pack tables — empty unless that pack is installed for a workspace': [
    'packs', 'pack_entity_schemas', 're_inquiries', 're_listings', 're_showings',
    'rera_cache', 'pm_charges', 'pm_leases',
  ],
  'billing — needs a payment provider connected': [
    'billing_invoices', 'billing_subscriptions', 'billing_webhook_events',
  ],
  'advanced memory graph — needs embeddings, which need GEMINI_API_KEY': [
    'conversation_memory', 'employee_memory', 'entity_memory', 'memory_edges',
    'knowledge_sources', 'ingestion_jobs',
  ],
  'product surfaces with no dedicated table yet': [
    'ask_ai_feedback', 'dsr_requests',
  ],
};

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

const count = async (sql) => {
  const r = await db.query(sql);
  return Number(r.rows[0]?.count ?? r.rows[0]?.[Object.keys(r.rows[0])[0]] ?? 0);
};

(async () => {
  await db.connect();
  console.log('\n=== DORMANT CAPABILITY — has each feature EVER produced a row? ===\n');

  const dormant = [];
  const waiting = [];

  try {
    // ── 1. Every declared capability ────────────────────────────────────────
    console.log('1. Shipped capabilities');
    for (const cap of CAPABILITIES) {
      if (cap.expectation === 'blocked' && !cap.blocker) {
        no(`${cap.name}: marked blocked without naming the blocker`,
          'an undocumented exemption is how a dead feature hides');
        continue;
      }

      const rows = await count(`SELECT COUNT(*) FROM ${cap.table}`);
      const triggers = await count(cap.trigger);

      if (rows > 0) {
        if (VERBOSE) ok(`${cap.name}`, `${rows} row(s) in ${cap.table}`);
        else pass++;
        continue;
      }

      if (triggers === 0) {
        // Never had the chance. Not a finding.
        if (VERBOSE) ok(`${cap.name}`, 'nothing has triggered it yet');
        else pass++;
        continue;
      }

      if (cap.expectation === 'every-turn') {
        no(`${cap.name.toUpperCase()} IS DEAD`,
          `${cap.table} is empty after ${triggers} chance(s) — ${cap.note}`);
        dormant.push(cap);
      } else {
        // Reported, not failed. The registry says what it waits for.
        waiting.push({ ...cap, triggers });
        pass++;
      }
    }
    if (!fail) ok('every capability that should have produced rows, has');

    // ── 2. The registry is complete ─────────────────────────────────────────
    // This is the part that catches the NEXT one: a new table nobody classified.
    console.log('\n2. The registry covers every table in the database');
    const live = (await db.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    )).rows.map((r) => r.tablename);

    const declared = new Set([
      ...CAPABILITIES.map((c) => c.table),
      ...Object.values(NON_CAPABILITY).flat(),
    ]);
    const unclassified = live.filter((t) => !declared.has(t));

    unclassified.length === 0
      ? ok(`all ${live.length} tables are classified`,
        `${CAPABILITIES.length} capabilities, ${declared.size - CAPABILITIES.length} non-capabilities`)
      : no(`${unclassified.length} table(s) shipped without being classified`,
        `${unclassified.join(', ')} — say whether each should ever have rows`);

    // A registry entry for a table that no longer exists is equally a lie.
    const stale = [...declared].filter((t) => !live.includes(t));
    stale.length === 0
      ? ok('no registry entry points at a table that no longer exists')
      : no(`${stale.length} registry entry(s) name a missing table`, stale.join(', '));

    // ── What is merely waiting ──────────────────────────────────────────────
    if (waiting.length) {
      console.log('\n─── EMPTY, AND THAT IS NOT A DEFECT ───\n');
      for (const w of waiting) {
        const why = w.expectation === 'blocked' ? `BLOCKED: ${w.blocker}` : w.note;
        console.log(`  ${w.table.padEnd(24)} ${w.expectation.padEnd(12)} ${why}`);
      }
    }

    if (dormant.length) {
      console.log('\n─── DEAD WIRING ───\n');
      for (const d of dormant) {
        console.log(`  ${d.table} — ${d.note}`);
        console.log('    built, tested, and never once reached in production.\n');
      }
    }
  } finally {
    await db.end().catch(() => {});
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
