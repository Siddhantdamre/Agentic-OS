#!/usr/bin/env node
'use strict';
/**
 * QUIET LEADS — the first work the agent does that nobody asked for.
 *
 * Finds people who enquired, got an answer, and then went silent; decides
 * which of them deserve one follow-up; drafts it; and records what it did —
 * including, deliberately, every lead it refused to contact and why.
 *
 * ── PREVIEW IS THE DEFAULT ────────────────────────────────────────────────
 * Nothing is sent unless BOTH are true:
 *   1. org_automation has mode='on' for trigger_key 'lead.quiet'
 *   2. --send is passed explicitly
 * Anything else drafts and records, and sends nothing. Unattended outbound
 * messaging is the highest-blast-radius thing this product can do: a bad reply
 * reaches one person, a bad campaign reaches everyone before anybody notices.
 *
 * ── THE JUDGEMENT LIVES IN ONE PLACE ──────────────────────────────────────
 * Every rule about who to leave alone is in services/workflows/src/leads/quiet.ts
 * and is unit-tested there — twelve of its tests assert that nothing is sent.
 * This file finds the rows and writes the outcome; it does not re-decide, so
 * the logic cannot drift between the tests and the thing that runs.
 *
 * Usage:
 *   node infra/scripts/quiet-leads.js                 preview every org
 *   node infra/scripts/quiet-leads.js --org <uuid>    one workspace
 *   node infra/scripts/quiet-leads.js --send          actually send (mode='on' still required)
 *   node infra/scripts/quiet-leads.js --settle        only sweep outcomes
 *   node infra/scripts/quiet-leads.js --report        what it has been worth
 *
 * Exit: 0 = ran, 1 = failed.
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

// One decision layer, shared with the unit tests. If this require fails the
// run aborts rather than falling back to an inline copy of the rules —
// duplicated judgement that drifts is worse than no run.
const {
  assessLead, summariseRevival, DEFAULT_POLICY,
} = require(path.join(__dirname, '..', '..', 'services', 'workflows', 'dist', 'leads', 'quiet.js'));

const args = process.argv.slice(2);
const DO_SEND = args.includes('--send');
const SETTLE_ONLY = args.includes('--settle');
const REPORT = args.includes('--report');
const ORG_ARG = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;

/**
 * Per-run, per-org cap.
 *
 * A condition query that suddenly matches ten thousand rows must not produce
 * ten thousand messages. The cap is reported when it bites — a silent
 * truncation reads as "we contacted everyone worth contacting", which is the
 * exact false impression this whole codebase keeps having to design against.
 */
const MAX_PER_ORG = Number(process.env.QUIET_LEADS_MAX_PER_ORG || 25);

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

/**
 * Candidate leads.
 *
 * Deliberately WIDE. It returns everything that could conceivably be a quiet
 * lead and lets the tested decision layer refuse them, rather than encoding
 * half the rules in SQL where nothing can unit-test them. The `cap + 1` is so
 * the runner can tell "exactly at the cap" from "more than the cap".
 */
const CANDIDATES = `
  SELECT c.id::text                         AS conversation_id,
         c.status                           AS status,
         c.contact_id                       AS contact_id,
         c.employee_id::text                AS employee_id,
         (SELECT MAX(m.created_at) FROM messages m
           WHERE m.conversation_id = c.id AND m.role = 'user')            AS last_customer_at,
         (SELECT MAX(m.created_at) FROM messages m
           WHERE m.conversation_id = c.id AND m.role IN ('assistant','human_agent')) AS last_outbound_at,
         (SELECT m.content FROM messages m
           WHERE m.conversation_id = c.id AND m.role = 'user'
           ORDER BY m.created_at DESC LIMIT 1)                            AS last_customer_text,
         COALESCE((SELECT COUNT(*) FROM lead_followups f
                    WHERE f.conversation_id = c.id AND f.status = 'sent'), 0)::int AS nudges_sent,
         (SELECT MAX(f.sent_at) FROM lead_followups f
           WHERE f.conversation_id = c.id AND f.status = 'sent')          AS last_nudge_at
    FROM conversations c
   WHERE c.org_id = $1
   ORDER BY c.updated_at DESC
   LIMIT $2`;

/**
 * The message itself.
 *
 * Grounded in what was actually discussed and deliberately plain. It does NOT
 * invent urgency ("prices are going up"), does not claim scarcity, and does
 * not pretend a human typed it. It asks one question and offers an exit,
 * because the follow-up a business would be embarrassed to have sent is worse
 * than no follow-up at all.
 *
 * No model call: this is a template over facts already in the conversation.
 * A generated message here would need the full grounding and critic pipeline
 * to be safe, would cost ~99k tokens per lead, and would buy nothing — the
 * value of this feature is that the message is sent at all, not that it is
 * eloquent.
 */
function draftFollowUp({ lastCustomerText, quietDays, nudgeNumber }) {
  const topic = summariseTopic(lastCustomerText);
  const opener = nudgeNumber === 1
    ? `Hello — following up on your enquiry${topic ? ` about ${topic}` : ''}.`
    : `Hello — checking in one last time about your enquiry${topic ? ` about ${topic}` : ''}.`;
  const close = nudgeNumber === 1
    ? 'Is this still something you are looking at? Happy to help either way.'
    : 'If the timing is not right, just say so and I will close this off.';
  return `${opener} It has been ${quietDays} days since we last spoke. ${close}`;
}

/**
 * A short, literal quotation of what they asked. Never a paraphrase.
 *
 * Their own casing is preserved. The first version lowercased it, which
 * produced "your enquiry about can i see the powai flat this weekend" — a
 * message no business would send, in which the customer's own sentence is
 * returned to them looking careless. Quoting someone means quoting them.
 */
function summariseTopic(text) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ').trim().replace(/[?.!]+$/, '');
  if (!t) return '';
  const quoted = t.length <= 60 ? t : `${t.slice(0, 57).trim()}…`;
  return `“${quoted}”`;
}

async function orgsToProcess() {
  if (ORG_ARG) return [ORG_ARG];
  const r = await db.query(
    `SELECT DISTINCT a.org_id::text AS id
       FROM org_automation a
      WHERE a.trigger_key = 'lead.quiet' AND a.mode IN ('dry_run','on')`);
  return r.rows.map((x) => x.id);
}

async function modeFor(orgId) {
  const r = await db.query(
    `SELECT mode, config FROM org_automation
      WHERE org_id = $1 AND trigger_key = 'lead.quiet'`, [orgId]);
  if (!r.rows.length) return { mode: 'off', policy: DEFAULT_POLICY };
  const cfg = r.rows[0].config || {};
  return {
    mode: r.rows[0].mode,
    policy: {
      ...DEFAULT_POLICY,
      ...(typeof cfg.minQuietDays === 'number' ? { minQuietDays: cfg.minQuietDays } : {}),
      ...(typeof cfg.maxQuietDays === 'number' ? { maxQuietDays: cfg.maxQuietDays } : {}),
      ...(typeof cfg.maxNudges === 'number' ? { maxNudges: cfg.maxNudges } : {}),
      ...(typeof cfg.cooldownDays === 'number' ? { cooldownDays: cfg.cooldownDays } : {}),
      ...(cfg.timeZone ? { timeZone: cfg.timeZone } : {}),
      ...(cfg.businessHours ? { businessHours: cfg.businessHours } : {}),
    },
  };
}

async function runOrg(orgId, now) {
  const { mode, policy } = await modeFor(orgId);
  const out = {
    orgId, mode, considered: 0, chase: 0, sent: 0, proposed: 0,
    suppressed: 0, skipped: {}, capped: false, examples: [],
  };
  if (mode === 'off') return out;

  const rows = (await db.query(CANDIDATES, [orgId, MAX_PER_ORG + 1])).rows;
  out.capped = rows.length > MAX_PER_ORG;
  const batch = rows.slice(0, MAX_PER_ORG);
  out.considered = batch.length;

  for (const r of batch) {
    const verdict = assessLead({
      conversationId: r.conversation_id,
      lastCustomerMessageAt: r.last_customer_at,
      lastOutboundAt: r.last_outbound_at,
      nudgesSent: Number(r.nudges_sent) || 0,
      lastNudgeAt: r.last_nudge_at,
      status: String(r.status || 'open'),
      // No opt-out column exists on conversations yet; a contact who asked to
      // stop is caught by the declined/opt-out text rules in the decision
      // layer. When a real preference store lands, this is where it reads.
      optedOut: false,
      lastCustomerText: r.last_customer_text,
    }, now, policy);

    if (!verdict.chase) {
      out.skipped[verdict.reason] = (out.skipped[verdict.reason] || 0) + 1;
      // Only a decision worth explaining is written down. Recording every
      // "not quiet yet" for every conversation on every hourly run would bury
      // the rows an operator actually needs to see.
      if (['customer_declined', 'complaint', 'already_nudged_enough', 'opted_out'].includes(verdict.reason)) {
        await db.query(
          `SELECT record_lead_followup($1::uuid,$2::uuid,$3::uuid,$4::int,$5::int,'skipped',$6::text,'')`,
          [orgId, r.conversation_id, r.employee_id || null,
            Math.max(1, Number(r.nudges_sent) + 1), verdict.quietDays, verdict.reason]);
      }
      continue;
    }

    out.chase++;
    const draft = draftFollowUp({
      lastCustomerText: r.last_customer_text,
      quietDays: verdict.quietDays,
      nudgeNumber: verdict.nudgeNumber,
    });

    // mode='on' AND --send. Either alone drafts and records nothing outbound.
    const willSend = mode === 'on' && DO_SEND;
    const status = willSend ? 'sent' : (mode === 'dry_run' ? 'suppressed' : 'proposed');

    // ALL OR NOTHING.
    //
    // The first version marked the row 'sent' and then wrote the message. A
    // constraint violation on the action insert left a ledger that claimed a
    // follow-up had gone out when nothing had — and record_lead_followup never
    // un-sends, so the lie was permanent. A ledger whose whole purpose is to
    // let an operator answer "did you message that customer?" must never be
    // able to say yes about a message that does not exist.
    let followupId = null;
    if (willSend) {
      await db.query('BEGIN');
      try {
        followupId = (await db.query(
          `SELECT record_lead_followup($1::uuid,$2::uuid,$3::uuid,$4::int,$5::int,'sent',NULL,$6::text) AS id`,
          [orgId, r.conversation_id, r.employee_id || null,
            verdict.nudgeNumber, verdict.quietDays, draft])).rows[0].id;

        // The message enters the conversation by the same path a reply does.
        await db.query(
          `INSERT INTO messages (org_id, conversation_id, role, content)
           VALUES ($1,$2,'assistant',$3)`,
          [orgId, r.conversation_id, draft]);

        // followup_sent, NOT reply_sent. The point of this feature is that the
        // agent acted first; filing it under the same kind as an answer would
        // make that invisible in the one table recording what the agent has
        // ever done. source_id points back at the judgement behind the action.
        await db.query(
          `INSERT INTO agent_actions
             (org_id, conversation_id, employee_id, action_kind, source_table, source_id, arm, occurred_at)
           VALUES ($1,$2,$3,'followup_sent','lead_followups',$4::text,'treatment',NOW())`,
          [orgId, r.conversation_id, r.employee_id || null, followupId]);

        await db.query('COMMIT');
        out.sent++;
      } catch (e) {
        await db.query('ROLLBACK').catch(() => {});
        out.skipped.send_failed = (out.skipped.send_failed || 0) + 1;
        out.chase--;
        continue;
      }
    } else {
      followupId = (await db.query(
        `SELECT record_lead_followup($1::uuid,$2::uuid,$3::uuid,$4::int,$5::int,$6::text,NULL,$7::text) AS id`,
        [orgId, r.conversation_id, r.employee_id || null,
          verdict.nudgeNumber, verdict.quietDays, status, draft])).rows[0].id;
      if (status === 'suppressed') out.suppressed++;
      else out.proposed++;
    }

    if (out.examples.length < 3) {
      out.examples.push({ quietDays: verdict.quietDays, nudge: verdict.nudgeNumber, draft });
    }
  }
  return out;
}

async function settle(orgId) {
  const r = await db.query(`SELECT settled FROM settle_lead_followups($1::uuid)`, [orgId]);
  return Number(r.rows[0] && r.rows[0].settled) || 0;
}

async function report(orgId) {
  const r = await db.query(
    `SELECT status, replied_at FROM lead_followups WHERE org_id = $1`, [orgId]);
  const outcomes = r.rows.map((x) =>
    x.status !== 'sent' ? 'not_sent' : (x.replied_at ? 'replied' : 'no_reply'));
  return summariseRevival(outcomes);
}

(async () => {
  await db.connect();
  const now = new Date();
  try {
    const orgs = await orgsToProcess();
    if (!orgs.length) {
      console.log('\n  No workspace has lead.quiet switched on.');
      console.log('  Nothing was examined and nothing was sent — this feature is opt-in twice:');
      console.log("    org_automation mode='dry_run' to watch it, 'on' plus --send to let it act.\n");
      return;
    }

    console.log(`\n=== QUIET LEADS === ${orgs.length} workspace(s)`
      + `${DO_SEND ? '  [SEND ARMED]' : '  [preview — nothing will be sent]'}\n`);

    for (const orgId of orgs) {
      const settled = await settle(orgId);

      if (SETTLE_ONLY || REPORT) {
        const stats = await report(orgId);
        console.log(`  ${orgId.slice(0, 8)}…  ${stats.headline}`
          + (settled ? `  (${settled} newly answered)` : ''));
        continue;
      }

      const r = await runOrg(orgId, now);
      const skips = Object.entries(r.skipped)
        .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ');

      console.log(`  ${orgId.slice(0, 8)}…  mode=${r.mode}  considered=${r.considered}`
        + `  worth chasing=${r.chase}`
        + `  sent=${r.sent} proposed=${r.proposed} suppressed=${r.suppressed}`);
      if (skips) console.log(`      left alone: ${skips}`);
      if (settled) console.log(`      ${settled} earlier follow-up(s) got a reply`);
      if (r.capped) {
        console.log(`      NOTE: more than ${MAX_PER_ORG} candidates — capped this run, the rest follow next run`);
      }
      for (const e of r.examples) {
        console.log(`      [nudge ${e.nudge}, quiet ${e.quietDays}d] ${e.draft}`);
      }
      const stats = await report(orgId);
      console.log(`      ${stats.headline}`);
    }
    console.log('');
  } finally {
    await db.end().catch(() => {});
  }
})().catch((e) => {
  console.error(`\n  ERROR: ${e.message}\n`);
  process.exit(1);
});
