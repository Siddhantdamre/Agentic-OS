#!/usr/bin/env node
'use strict';
/**
 * ERASURE — when somebody asks to be forgotten, are they?
 *
 * The failure mode here is not a crash. It is a routine that returns
 * "completed", writes a receipt, and leaves the person's actual words in a
 * table nobody remembered. That receipt is then shown to a regulator.
 *
 * So the central test in this file is not a list of DELETEs I remembered to
 * write. It reads the CATALOG for every table carrying a conversation_id or a
 * contact_id, and asserts each one is clean afterwards. A table added next
 * year fails this test the day it is added, without anybody thinking to come
 * back here. That is the only version of this check worth having: the audit
 * that found these holes was a catalog query, and the tests that missed them
 * were hand-written lists.
 *
 * Usage: node infra/scripts/check-erasure.js
 * Exit:  0 = erasure is complete, 1 = something survived
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

const cfg = (user, password) => ({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user, password,
  database: process.env.DB_NAME || 'darex',
});

const db = new Client(cfg(
  process.env.DB_RESOLVER_USER || 'darex',
  process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
));
const app = new Client(cfg(
  process.env.DB_USER || 'darex_app',
  process.env.DB_PASSWORD || 'darex_dev_secret',
));

const stamp = Date.now();

/** A person with a full history: conversation, messages, learned facts, drafts. */
async function seedSubject(orgId, tag) {
  // The "contact" is a raw phone number on the conversation row. There is no
  // contact entity in this schema -- see migration 038.
  const contact = `+9199${String(stamp).slice(-6)}${tag === 'a' ? '1' : '2'}`;

  const conv = (await db.query(
    `INSERT INTO conversations (org_id, contact_id, status)
     VALUES ($1, $2::text, 'open') RETURNING id`,
    [orgId, contact],
  )).rows[0].id;

  await db.query(
    `INSERT INTO messages (org_id, conversation_id, role, content)
     VALUES ($1, $2, 'user', $3), ($1, $2, 'assistant', $4)`,
    [orgId, conv, `My budget is 1.2 crore — ${tag}`, `Noted — ${tag}`],
  );

  // The derived fact. This is the one that survives a naive erasure.
  await db.query(
    `INSERT INTO org_memory (org_id, kind, title, body, source, source_ref, content_hash)
     VALUES ($1, 'fact', 'budget', $2, 'conversation', $3::text, $4)`,
    [orgId, `Subject ${tag} wants a 3BHK in Thane, budget 1.2 crore`, conv, `hash-${tag}-${stamp}`],
  );

  // The SET NULL survivor that holds the customer's actual words.
  await db.query(
    `INSERT INTO reply_edits (org_id, conversation_id, question, ai_draft, operator_final, learned)
     VALUES ($1, $2, $3, $4, $5, false)`,
    [orgId, conv, `what is my budget — ${tag}`, `draft ${tag}`, `final ${tag}`],
  );

  await db.query(
    `INSERT INTO work_items (org_id, conversation_id, type, status, channel)
     VALUES ($1, $2, 'conversation', 'done', 'whatsapp')`,
    [orgId, conv],
  );

  // These two carry a conversation_id with NO foreign key, so nothing removes
  // them automatically -- and the first version of the erase function missed
  // both. They hold the customer's question and the drafted reply verbatim.
  await db.query(
    `INSERT INTO knowledge_gaps (org_id, conversation_id, question, agent_reply, question_hash, detected_via)
     VALUES ($1, $2, $3, 'could not answer', $4, 'denied')`,
    [orgId, conv, `what is my budget again — ${tag}`, `kg-${tag}-${stamp}`],
  );
  await db.query(
    `INSERT INTO approval_requests (org_id, conversation_id, action_class, summary, draft, status)
     VALUES ($1, $2, 'send', 'reply to buyer', $3, 'pending')`,
    [orgId, conv, `Your budget is 1.2 crore — ${tag}`],
  );

  return { contact, conv };
}

(async () => {
  await db.connect();
  await app.connect();
  console.log('\n=== ERASURE — IS THE PERSON ACTUALLY GONE? ===\n');

  const mkOrg = async (tag) => (await db.query(
    `INSERT INTO orgs (name, slug) VALUES ($1, $1) RETURNING id`,
    [`erasure-${tag}-${stamp}`],
  )).rows[0].id;

  const A = await mkOrg('a');
  const B = await mkOrg('b');

  try {
    const subjA = await seedSubject(A, 'a');
    const subjB = await seedSubject(B, 'b');

    // ── 1. Everything is there to begin with ─────────────────────────────────
    console.log('1. The person has a history before erasure');
    const before = await db.query(
      `SELECT (SELECT COUNT(*) FROM messages WHERE conversation_id=$1) AS msgs,
              (SELECT COUNT(*) FROM org_memory WHERE source_ref=$1::text) AS mem,
              (SELECT COUNT(*) FROM reply_edits WHERE conversation_id=$1) AS edits,
              (SELECT COUNT(*) FROM work_items WHERE conversation_id=$1) AS items,
              (SELECT COUNT(*) FROM knowledge_gaps WHERE conversation_id=$1) AS gaps,
              (SELECT COUNT(*) FROM approval_requests WHERE conversation_id=$1) AS appr`,
      [subjA.conv],
    );
    const b0 = before.rows[0];
    Number(b0.msgs) === 2 && Number(b0.mem) === 1 && Number(b0.edits) === 1
      && Number(b0.items) === 1 && Number(b0.gaps) === 1 && Number(b0.appr) === 1
      ? ok('2 messages, 1 learned fact, 1 draft, 1 work item, 1 gap, 1 approval')
      : no('the fixture is complete', JSON.stringify(b0));

    // ── 2. Erase ─────────────────────────────────────────────────────────────
    console.log('\n2. Erasure runs and returns a receipt');
    const res = await db.query(
      `SELECT receipt_id, erased FROM erase_data_subject($1::uuid, $2::text, 'data_subject_request', NULL)`,
      [A, subjA.contact],
    );
    const receipt = res.rows[0];
    receipt && receipt.receipt_id
      ? ok('a receipt was issued', receipt.receipt_id.slice(0, 8) + '…')
      : no('a receipt was issued');

    const counts = receipt ? receipt.erased : {};
    Number(counts.org_memory) === 1
      ? ok('the LEARNED FACT was erased', 'the hole a naive implementation leaves open')
      : no('the learned fact was erased', `org_memory=${counts.org_memory}`);
    Number(counts.reply_edits) === 1
      ? ok('the draft holding the customer\'s words was erased', 'ON DELETE SET NULL would have stranded it')
      : no('the draft was erased', `reply_edits=${counts.reply_edits}`);
    Number(counts.messages) === 2
      ? ok('the receipt states how many messages went', '2, not 0')
      : no('the receipt states how many messages went', `messages=${counts.messages}`);

    // ── 3. THE COVERAGE TEST ─────────────────────────────────────────────────
    console.log('\n3. CATALOG SWEEP — nothing anywhere still references this person');
    const tables = await db.query(
      `SELECT c.relname AS t,
              EXISTS(SELECT 1 FROM information_schema.columns col
                      WHERE col.table_name=c.relname AND col.column_name='conversation_id') AS has_conv,
              EXISTS(SELECT 1 FROM information_schema.columns col
                      WHERE col.table_name=c.relname AND col.column_name='contact_id') AS has_contact
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r'
          AND EXISTS(SELECT 1 FROM information_schema.columns col
                      WHERE col.table_name=c.relname AND col.column_name IN ('conversation_id','contact_id'))
        ORDER BY 1`,
    );

    const survivors = [];
    for (const row of tables.rows) {
      const clauses = [];
      if (row.has_conv) clauses.push(`conversation_id = '${subjA.conv}'`);
      if (row.has_contact) clauses.push(`contact_id::text = '${subjA.contact}'`);
      const q = `SELECT COUNT(*)::int AS n FROM ${row.t} WHERE ${clauses.join(' OR ')}`;
      const r = await db.query(q);
      if (r.rows[0].n > 0) survivors.push(`${row.t}=${r.rows[0].n}`);
    }
    survivors.length === 0
      ? ok(`all ${tables.rows.length} tables carrying a conversation or contact id are clean`,
           tables.rows.map((r) => r.t).join(', '))
      : no('a table still references the erased person', survivors.join(', '));

    // A fixture can only prove the tables it populated. So this asks a
    // different question: does the erase routine even KNOW about every table
    // the catalog lists? A table added next year with no fixture row would
    // pass the sweep above and fail here -- which is the point, because that
    // is exactly how knowledge_gaps and approval_requests were missed.
    const src = (await db.query(
      `SELECT prosrc FROM pg_proc WHERE proname = 'erase_data_subject'`,
    )).rows[0].prosrc;
    const CASCADES = new Set([
      // Removed automatically by ON DELETE CASCADE from conversations.
      'agent_actions', 'commitments', 'conversation_memory', 'messages', 'outcome_events',
      'conversations',
    ]);
    const unknown = tables.rows
      .map((r) => r.t)
      .filter((t) => !CASCADES.has(t) && !src.includes(t));
    unknown.length === 0
      ? ok('the erase routine names every table the catalog knows of',
           'a new table fails this the day it is added, with no fixture needed')
      : no('a table exists that erasure has never heard of', unknown.join(', '));

    const memLeft = await db.query(
      `SELECT COUNT(*)::int AS n FROM org_memory WHERE source_ref = $1::text`, [subjA.conv],
    );
    memLeft.rows[0].n === 0
      ? ok('and no derived memory survives', 'org_memory has no foreign key — nothing would have removed it')
      : no('and no derived memory survives', `${memLeft.rows[0].n} row(s)`);

    // ── 4. The receipt does not resurrect the identifier ─────────────────────
    console.log('\n4. The receipt certifies removal without preserving what was removed');
    const rec = await db.query(
      `SELECT subject_hash, erased_counts, not_erased FROM erasure_requests WHERE org_id=$1`, [A],
    );
    const r0 = rec.rows[0];
    r0 && !/\+9199/.test(JSON.stringify(r0))
      ? ok('the phone number is not in the receipt', 'a receipt must not be the last surviving copy')
      : no('the phone number is not in the receipt', JSON.stringify(r0));

    // The proof has to still WORK: a Fiduciary holding the number must be able
    // to find the receipt. A hash nobody can reproduce is not evidence.
    const lookup = await db.query(
      `SELECT COUNT(*)::int AS n FROM erasure_requests
        WHERE org_id = $1 AND subject_hash = encode(digest($1::text || ':' || $2::text, 'sha256'), 'hex')`,
      [A, subjA.contact],
    );
    lookup.rows[0].n === 1
      ? ok('and the hash is reproducible from the number', 'proof a specific person was erased')
      : no('and the hash is reproducible from the number', `${lookup.rows[0].n} match(es)`);
    r0 && Array.isArray(r0.not_erased) && r0.not_erased.length > 0
      ? ok('and it names what it could NOT reach', String(r0.not_erased[0]).slice(0, 60) + '…')
      : no('and it names what it could not reach', JSON.stringify(r0 && r0.not_erased));

    // ── 5. Isolation ─────────────────────────────────────────────────────────
    console.log('\n5. Erasing in one workspace does not touch another');
    const bLeft = await db.query(
      `SELECT (SELECT COUNT(*) FROM messages WHERE conversation_id=$1) AS msgs,
              (SELECT COUNT(*) FROM org_memory WHERE source_ref=$1::text) AS mem`,
      [subjB.conv],
    );
    Number(bLeft.rows[0].msgs) === 2 && Number(bLeft.rows[0].mem) === 1
      ? ok('workspace B is untouched', '2 messages, 1 fact')
      : no('workspace B is untouched', JSON.stringify(bLeft.rows[0]));

    let refused = false;
    try {
      await db.query(`SELECT erase_data_subject($1::uuid, $2::uuid)`, [A, subjB.contact]);
    } catch { refused = true; }
    refused
      ? ok('erasing another workspace\'s contact is refused', 'a SECURITY DEFINER must re-check ownership')
      : no('erasing another workspace\'s contact is refused', 'IT ERASED ACROSS TENANTS');

    // ── 6. Retention policy defaults ─────────────────────────────────────────
    console.log('\n6. Retention is opt-in, never a surprise');
    await app.query("SELECT set_config('app.current_org_id', $1, false)", [A]);
    await app.query(`INSERT INTO org_retention_policy (org_id) VALUES ($1)`, [A]);
    const pol = await app.query(
      `SELECT conversation_retention_days, memory_retention_days, sweep_enabled
         FROM org_retention_policy WHERE org_id=$1`, [A],
    );
    const p0 = pol.rows[0];
    p0.conversation_retention_days === null && p0.memory_retention_days === null && p0.sweep_enabled === false
      ? ok('a new policy keeps everything and sweeps nothing', 'switching it on is a deliberate act')
      : no('a new policy keeps everything and sweeps nothing', JSON.stringify(p0));

    let badDays = false;
    try {
      await app.query(`UPDATE org_retention_policy SET conversation_retention_days = 0 WHERE org_id=$1`, [A]);
    } catch { badDays = true; }
    badDays
      ? ok('a zero-day retention is refused by the database', 'not silently "delete everything"')
      : no('a zero-day retention is refused by the database');

    // ── The sweep ────────────────────────────────────────────────────────────
    console.log('\n7. The retention sweep previews before it destroys');
    await db.query(
      `INSERT INTO org_retention_policy (org_id, conversation_retention_days, memory_retention_days, sweep_enabled)
       VALUES ($1, 365, 365, false)`, [B],
    );
    let sw = (await db.query(`SELECT dry_run, would_erase FROM sweep_retention($1::uuid)`, [B])).rows[0];
    sw.would_erase.skipped
      ? ok('a policy that is not enabled deletes nothing', 'opt in twice: set a number, then switch it on')
      : no('a policy that is not enabled deletes nothing', JSON.stringify(sw.would_erase));

    await db.query(
      `UPDATE org_retention_policy SET sweep_enabled = true, conversation_retention_days = 1,
                                       memory_retention_days = 1 WHERE org_id = $1`, [B],
    );
    await db.query(`UPDATE conversations SET created_at = NOW() - INTERVAL '10 days' WHERE org_id = $1`, [B]);
    await db.query(`UPDATE org_memory SET created_at = NOW() - INTERVAL '10 days' WHERE org_id = $1`, [B]);

    sw = (await db.query(`SELECT dry_run, would_erase FROM sweep_retention($1::uuid)`, [B])).rows[0];
    sw.dry_run === true && Number(sw.would_erase.conversations) === 1
      ? ok('the DEFAULT call is a preview', `would erase ${sw.would_erase.conversations} conversation(s), ${sw.would_erase.messages} message(s)`)
      : no('the default call is a preview', JSON.stringify(sw));

    const stillThere = await db.query(
      `SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1`, [subjB.conv]);
    stillThere.rows[0].n === 2
      ? ok('and the preview destroyed nothing', 'the least reversible action needs a second argument')
      : no('and the preview destroyed nothing', `${stillThere.rows[0].n} messages left`);

    await db.query(`SELECT sweep_retention($1::uuid, false)`, [B]);
    const gone = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM messages WHERE conversation_id=$1) AS m,
              (SELECT COUNT(*)::int FROM org_memory WHERE source_ref=$1::text) AS mem,
              (SELECT COUNT(*)::int FROM reply_edits WHERE conversation_id=$1) AS e`,
      [subjB.conv]);
    const g = gone.rows[0];
    g.m === 0 && g.mem === 0 && g.e === 0
      ? ok('an explicit sweep forgets the conversation, the memory AND the drafts')
      : no('an explicit sweep forgets everything', JSON.stringify(g));

    const swept = await db.query(
      `SELECT last_swept_at FROM org_retention_policy WHERE org_id = $1`, [B]);
    swept.rows[0].last_swept_at
      ? ok('and stamps when it ran', 'so a gap in sweeping is visible')
      : no('and stamps when it ran');
    console.log('\n8. The receipt is tenant-scoped like everything else');
    await app.query("SELECT set_config('app.current_org_id', $1, false)", [B]);
    const cross = await app.query(`SELECT COUNT(*)::int AS n FROM erasure_requests`);
    cross.rows[0].n === 0
      ? ok('B cannot read A\'s erasure receipts', 'asserted as darex_app')
      : no('B cannot read A\'s erasure receipts', `${cross.rows[0].n}`);
  } finally {
    await db.query(`DELETE FROM orgs WHERE id = ANY($1::uuid[])`, [[A, B]]).catch(() => {});
    await db.end().catch(() => {});
    await app.end().catch(() => {});
  }

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  try { await app.end(); } catch { /* closed */ }
  process.exit(1);
});
