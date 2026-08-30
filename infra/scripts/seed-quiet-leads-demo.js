#!/usr/bin/env node
'use strict';
/**
 * A realistic broker workspace for exercising the quiet-lead agent.
 *
 * Eight conversations chosen so that only TWO of them should ever be
 * contacted. The other six are each a different way this feature could
 * embarrass a business, and they exist so that a run which contacts more than
 * two is visibly wrong rather than quietly wrong.
 *
 * Usage: node infra/scripts/seed-quiet-leads-demo.js [--mode dry_run|on]
 * Prints the org id on stdout.
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const args = process.argv.slice(2);
const MODE = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'dry_run';

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

/** [label, what the customer last said, days since they wrote, days since we replied, status] */
const LEADS = [
  ['CHASE  price enquiry, we answered, silence',      'What is the price for the 3BHK in Thane?', 12, 11, 'open'],
  ['CHASE  viewing request, we answered, silence',    'Can I see the Powai flat this weekend?',     8,  7, 'open'],
  ['LEAVE  said no',                                  'Not interested, we went with someone else', 10,  9, 'open'],
  ['LEAVE  complaint',                                'Any update on my refund? Still waiting.',   10,  9, 'open'],
  ['LEAVE  we owe them a reply',                      'Can you send the floor plan?',               9, null, 'open'],
  ['LEAVE  too recent',                               'Is parking included?',                       1,  1, 'open'],
  ['LEAVE  ancient',                                  'Looking for a 2BHK',                       120, 119, 'open'],
  ['LEAVE  already closed',                           'Booked it, thanks!',                        10,  9, 'closed'],
];

(async () => {
  await db.connect();
  const stamp = Date.now();
  try {
    const org = (await db.query(
      'INSERT INTO orgs (name, slug) VALUES ($1, $1) RETURNING id',
      [`quietdemo-${stamp}`])).rows[0].id;

    // persona is jsonb, not text — a bare string is rejected as invalid JSON.
    const employee = (await db.query(
      `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist)
       VALUES ($1, 'Priya', 'sales', $2::jsonb, ARRAY['database_query'])
       RETURNING id`,
      [org, JSON.stringify({ summary: 'Follows up on property enquiries.' })])).rows[0].id;

    let i = 0;
    for (const [, text, custDays, ourDays, status] of LEADS) {
      i += 1;
      const conv = (await db.query(
        `INSERT INTO conversations (org_id, contact_id, status, employee_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [org, `+9199${String(stamp).slice(-6)}${i}`, status, employee])).rows[0].id;

      await db.query(
        `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
         VALUES ($1, $2, 'user', $3, NOW() - ($4 || ' days')::interval)`,
        [org, conv, text, String(custDays)]);

      if (ourDays !== null) {
        await db.query(
          `INSERT INTO messages (org_id, conversation_id, role, content, created_at)
           VALUES ($1, $2, 'assistant', $3, NOW() - ($4 || ' days')::interval)`,
          [org, conv, 'Thanks for asking — here are the details you wanted.', String(ourDays)]);
      }
    }

    await db.query(
      `INSERT INTO org_automation (org_id, trigger_key, mode, config, enabled_at)
       VALUES ($1, 'lead.quiet', $2, $3::jsonb, NOW())`,
      [org, MODE, JSON.stringify({ timeZone: 'Asia/Kolkata', businessHours: { start: 0, end: 24 } })]);

    console.log(org);
  } finally {
    await db.end().catch(() => {});
  }
})().catch((e) => {
  console.error(`seed failed: ${e.message}`);
  process.exit(1);
});
