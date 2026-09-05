#!/usr/bin/env node
'use strict';
/**
 * ONE SMALL BUSINESS, TRUE ENOUGH TO REASON ABOUT.
 *
 * Not a dataset. A workspace with 18 facts, 5 policies, 4 open tasks and — the
 * part that actually matters — THREE DELIBERATE CONTRADICTIONS planted in the
 * records.
 *
 * The contradictions are the point. Anyone can build a knowledge base where
 * retrieval finds the one right answer; that proves a search index works. What
 * nobody demonstrates is what happens when a real business's records disagree
 * with themselves, which they always do: a price list updated in March and a
 * policy PDF from January, a website that says 7 days and an email that
 * promised the weekend. A system that averages those, or picks the first one it
 * retrieved, is worse than useless — it is confidently wrong on exactly the
 * questions that cost money.
 *
 * This workspace makes those cases reachable in one command, so the behaviour
 * can be watched instead of asserted:
 *
 *   CONFLICT 1  installation lead time   7-10 days   vs   3-4 days
 *   CONFLICT 2  cancellation window      48 hours    vs   7 days
 *   CONFLICT 3  delivery radius          15 km       vs   25 km
 *
 * Each is planted with a DATE and a SOURCE, because that is what a human uses
 * to resolve one and therefore what the agent must surface: not "the answer is
 * 7 days" but "your March price list says 3-4 days and your January policy says
 * 7-10; which governs?"
 *
 * Deliberately small. Storage was the constraint that prompted this, and a
 * bigger corpus would not test anything a smaller one cannot. Eighteen facts is
 * enough to be answerable and small enough to hold in your head while you watch
 * the agent work — which is what makes a demo believable to someone who does
 * not trust it yet.
 *
 * Usage:
 *   node infra/scripts/seed-minimal-business.js            new workspace
 *   node infra/scripts/seed-minimal-business.js <orgId>    seed an existing one
 *
 * Prints the workspace id, the login, and the exact questions to ask.
 */
const crypto = require('crypto');
const path = require('path');

let Client;
try {
  Client = require('pg').Client;
} catch {
  Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client;
}

const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '6432', 10),
  user: process.env.DB_USER || 'darex_app',
  password: process.env.DB_PASSWORD || 'darex_app_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const BUSINESS = { name: 'Bright Leaf Interiors', type: 'interior fit-out and furniture' };

// ── 18 facts a real fit-out business would actually hold ────────────────────
const FACTS = [
  ['Showroom hours', 'The showroom is open Monday to Saturday, 10 am to 7 pm. Closed on Sundays and public holidays.'],
  ['Showroom address', 'The showroom is at 14 MG Road, Andheri West, Mumbai 400058. Customer parking is behind the building, accessed from the rear lane.'],
  ['Consultation fee', 'An initial design consultation costs 2,500 rupees, credited in full against any order above 50,000 rupees.'],
  ['Sofa pricing', 'The Aspen three-seater fabric sofa is 45,000 rupees. The two-seater is 32,000 rupees. Leather upholstery adds 18 percent.'],
  ['Dining pricing', 'The solid oak six-seater dining table is 58,000 rupees. Chairs are 6,500 rupees each and sold separately.'],
  ['Kitchen pricing', 'A modular kitchen is quoted per running foot: 1,850 rupees per rft for laminate, 3,200 for acrylic, 4,600 for lacquered glass.'],
  ['Wardrobe pricing', 'Built-in wardrobes are 1,450 rupees per square foot of shutter area, including internal fittings.'],
  ['Delivery time', 'In-stock items are delivered within 3 to 5 working days.'],
  ['Custom lead time', 'Custom and made-to-order pieces take 4 to 6 weeks from design sign-off.'],
  ['Installation charge', 'Standard installation is charged at 8 percent of the order value.'],
  ['Warranty', 'Upholstered furniture carries a 10-year frame warranty and a 3-year fabric warranty. Modular units carry 5 years on hardware.'],
  ['EMI', 'EMI is available on orders above 25,000 rupees through Bajaj Finserv and major credit cards, over 3, 6 or 9 months.'],
  ['Payment terms', 'Orders require 50 percent advance on confirmation and the balance before dispatch. Site work is billed 40/40/20.'],
  ['GST', 'All invoices carry GST. Furniture is billed at 18 percent and site fabrication work at 18 percent.'],
  ['Site visit', 'A site measurement visit is free within Mumbai and Thane and is scheduled within 3 working days of a confirmed consultation.'],
  ['Materials', 'Carcass is 16 mm BWR plywood as standard. MDF is offered only for painted shutters, never for wet areas.'],
  ['Aftercare', 'One free cushion re-fill is included within the first two years. Aftercare visits run on Tuesdays and Thursdays.'],
  ['Team', 'Four designers and two site supervisors. Peak season is October to January, when lead times run at the upper end.'],
];

// ── 5 policies, worded the way a policy document is ─────────────────────────
const POLICIES = [
  ['Cancellation policy', 'Orders may be cancelled free of charge within 48 hours of confirmation. After 48 hours a 10 percent restocking fee applies. Made-to-order items cannot be cancelled once cutting has begun.'],
  ['Refund policy', 'Approved refunds are processed to the original payment method within 7 to 10 working days. The consultation fee is non-refundable once the design has been presented.'],
  ['Delivery area policy', 'Delivery is free within 15 km of the showroom. Beyond that a charge of 1,200 rupees applies. We do not deliver outside Maharashtra.'],
  ['Damage and claims policy', 'Transit damage must be reported in writing within 48 hours of delivery, with photographs. Claims after 48 hours are assessed case by case.'],
  ['Discount policy', 'Only the owner may approve a discount. Staff and automated assistants must never offer, imply or match a discount, including in response to a competitor quote.'],
];

/**
 * THREE CONTRADICTIONS, EACH DATED AND SOURCED.
 *
 * Planted so the correct behaviour is visible: surface both, name where each
 * came from, and ask which governs. Never average, never silently pick one.
 *
 * `source_ref` carries the document and the month, because that is exactly what
 * a human uses to decide — and an agent that reports the conflict without
 * saying which is newer has done half the job.
 */
const CONFLICTS = [
  {
    subject: 'installation lead time',
    a: ['Installation lead time (policy)', 'Interior installation normally takes 7 to 10 working days from delivery of materials.', 'policy-handbook-january.pdf'],
    b: ['Installation lead time (price list)', 'Installation is completed in 3 to 4 working days for standard fit-outs.', 'price-list-march.xlsx'],
    ask: 'How long does installation take?',
  },
  {
    subject: 'cancellation window',
    a: ['Cancellation window (policy)', 'Orders may be cancelled free of charge within 48 hours of confirmation.', 'policy-handbook-january.pdf'],
    b: ['Cancellation window (website copy)', 'Customers enjoy a full 7 day cooling-off period on every order.', 'website-copy-march.docx'],
    ask: 'If I change my mind, how long do I have to cancel?',
  },
  {
    subject: 'delivery radius',
    a: ['Delivery radius (policy)', 'Delivery is free within 15 km of the showroom.', 'policy-handbook-january.pdf'],
    b: ['Delivery radius (sales email)', 'We deliver free anywhere within 25 km, no questions asked.', 'sales-email-february.eml'],
    ask: 'Is delivery free to my address 20 km away?',
  },
];

// ── 10 customer messages, the way customers actually write ──────────────────
//
// Two of them land directly on a planted conflict, which is the point: the
// interesting behaviour is not retrieval, it is what happens when the records
// disagree and a customer is waiting.
const CUSTOMER_MESSAGES = [
  { from: 'priya.mehta@gmail.com', subject: 'sofa price', body: '3 seater sofa price?' },
  { from: 'r.iyer@yahoo.in', subject: 'Kitchen installation this weekend', body: 'Hi, we have just moved in and the kitchen is the last thing left. Can you install my kitchen this weekend? We are quite desperate.', hits: 'installation lead time' },
  { from: 'anita.desai@outlook.com', subject: 'Matching a quote', body: 'The shop near Linking Road quoted me 20% less for a similar wardrobe. Can you match it? Otherwise I will go with them.' },
  { from: 'vikram.s@gmail.com', subject: 'Where is my order', body: 'This is ridiculous. I paid for my dining set three weeks ago and heard nothing since. Where is it? I want to speak to whoever is in charge.' },
  { from: 'sunita.k@gmail.com', subject: 'EMI', body: 'bhaiya 3 seater sofa ka price kya hai? aur EMI available hai kya?' },
  { from: 'deepak.rao@gmail.com', subject: '(no subject)', body: 'hi' },
  { from: 'meera.nair@company.co.in', subject: 'Bulk order - 40 chairs', body: 'I need 40 chairs for our new office in BKC. What is the bulk price, what is the lead time, and can you invoice with GST? We need this closed this month.' },
  { from: 'faisal.ahmed@gmail.com', subject: 'Cancelling my order', body: 'I placed an order four days ago and want to cancel. Your website said I had a week to change my mind. Please confirm there is no charge.', hits: 'cancellation window' },
  { from: 'lakshmi.g@gmail.com', subject: 'Delivery to Powai', body: 'We are in Powai, about 20 km from your showroom. Is delivery free to us?', hits: 'delivery radius' },
  { from: 'arjun.kapoor@gmail.com', subject: 'Damaged table', body: 'The dining table arrived yesterday with a deep scratch on the top. What do I do now?' },
];

// ── 4 open tasks a supervisor would have on their list ──────────────────────
const TASKS = [
  'Chase the BKC office bulk enquiry — 40 chairs, needs GST invoice and a lead time.',
  'Resolve the installation lead time discrepancy between the January handbook and the March price list.',
  'Confirm whether the 25 km free-delivery promise in the February sales email is still honoured.',
  'Schedule the Powai site measurement visit once delivery scope is confirmed.',
];

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function insertFact(orgId, title, body, sourceRef, kind = 'fact') {
  await db.query(
    `INSERT INTO org_memory (org_id, kind, title, body, source, source_ref, content_hash)
     VALUES ($1,$2,$3,$4,'upload',$5,$6)
     ON CONFLICT DO NOTHING`,
    [orgId, kind, title, body, sourceRef, hash(title + body)]
  );
}

async function main() {
  await db.connect();
  let orgId = process.argv[2];
  let login = null;

  if (!orgId) {
    const stamp = `${Date.now()}`;
    const email = `owner_${stamp}@brightleaf.test`;
    const password = `Leaf-${stamp}-Aa1!`;
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.orgId) throw new Error(`register failed: HTTP ${res.status}. Is the dashboard up?`);
    orgId = body.orgId;
    login = { email, password };
  }

  // RLS is on, and correctly refused these writes until the tenant was named.
  // `false` rather than `true`: this is a session-wide seed, not one transaction.
  await db.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);

  await db.query(`UPDATE orgs SET name = $2 WHERE id = $1`, [orgId, BUSINESS.name]);
  // The identity the agent is given. Without business_type the prompt omits
  // the industry rather than guessing, so a demo workspace sets it properly.
  await db.query(
    `INSERT INTO org_onboarding (org_id, wizard_step, business_name, business_type)
     VALUES ($1,'done',$2,$3)
     ON CONFLICT (org_id) DO UPDATE
       SET business_name = EXCLUDED.business_name, business_type = EXCLUDED.business_type`,
    [orgId, BUSINESS.name, BUSINESS.type]
  ).catch(() => { /* optional: identity degrades honestly without it */ });

  for (const [t, b] of FACTS) await insertFact(orgId, t, b, 'facts-current.md');
  for (const [t, b] of POLICIES) await insertFact(orgId, t, b, 'policy-handbook-january.pdf', 'policy');

  for (const c of CONFLICTS) {
    await insertFact(orgId, c.a[0], c.a[1], c.a[2], 'policy');
    await insertFact(orgId, c.b[0], c.b[1], c.b[2], 'fact');
  }

  // Employees, with the allowlists the packs use.
  const employees = [
    ['Sarah', 'Sales / front-of-house', ['database_query', 'web_search']],
    ['Emma', 'Support / success', ['database_query']],
    ['Kabir', 'Showing coordinator', ['database_query', 'google-calendar']],
  ];
  for (const [name, role, tools] of employees) {
    await db.query(
      `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, status)
       VALUES ($1,$2,$3,$4::jsonb,$5::text[],'active')
       ON CONFLICT DO NOTHING`,
      [orgId, name, role,
        JSON.stringify({ tone: 'Warm and direct. Lead with the number. Never invent a price, a discount, an order status or availability.' }),
        tools]
    );
  }

  console.log('');
  console.log('  ONE SMALL BUSINESS, SEEDED');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log(`  workspace : ${BUSINESS.name} (${BUSINESS.type})`);
  console.log(`  org id    : ${orgId}`);
  if (login) {
    console.log(`  login     : ${login.email}`);
    console.log(`  password  : ${login.password}`);
  }
  console.log(`  seeded    : ${FACTS.length} facts, ${POLICIES.length} policies, `
    + `${CONFLICTS.length} planted conflicts, ${employees.length} employees`);
  console.log('');
  console.log('  THE THREE QUESTIONS THAT MATTER — each hits a contradiction in');
  console.log('  the records. A good answer surfaces BOTH sides and asks which');
  console.log('  governs. Averaging them, or silently picking one, is the failure.');
  console.log('');
  for (const c of CONFLICTS) {
    console.log(`    "${c.ask}"`);
    console.log(`        ${c.a[1]}`);
    console.log(`          └─ ${c.a[2]}`);
    console.log(`        ${c.b[1]}`);
    console.log(`          └─ ${c.b[2]}`);
    console.log('');
  }
  console.log('  TEN CUSTOMER MESSAGES to send through the inbox:');
  for (const m of CUSTOMER_MESSAGES) {
    const flag = m.hits ? `   <- lands on the ${m.hits} conflict` : '';
    console.log(`    ${m.from.padEnd(30)} ${JSON.stringify(m.body.slice(0, 52))}${flag}`);
  }
  console.log('');
  console.log('  FOUR OPEN TASKS a supervisor would be carrying:');
  for (const t of TASKS) console.log(`    - ${t}`);
  console.log('');
  console.log('  NEXT');
  console.log(`    node infra/scripts/journey-suite.js            eight customers, scored`);
  console.log(`    open ${BASE}/decide and ask one of the three questions above`);
  console.log('');

  await db.end();
}

main().catch(async (e) => {
  console.error('\nseed failed:', e.message);
  try { await db.end(); } catch { /* already closed */ }
  process.exit(1);
});
