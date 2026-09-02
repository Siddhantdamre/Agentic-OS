#!/usr/bin/env node
'use strict';
/**
 * ARE YOU READY TO DEMO THIS? — run it an hour before, and again ten minutes before.
 *
 * A demo fails in one of four ways, and none of them are "the architecture was
 * wrong":
 *
 *   the agent cannot answer          no credit, and it is silent in front of people
 *   a container is down              the page that worked this morning 500s now
 *   the workspace looks like a test  "q_1786836142243211's Organization"
 *   it answers when you promised     shadow mode off while you say nothing is sent
 *
 * So this checks those four, in that order, and gives one verdict. It is
 * deliberately blunt: GO or NO-GO, with the reason and the fix.
 *
 * It does NOT check code quality. verify.js does that and it passes. This asks a
 * different question: is this machine, right now, in a state you can present.
 *
 * Usage:
 *   node infra/scripts/check-demo-ready.js
 *   node infra/scripts/check-demo-ready.js --org <uuid>   the workspace you will show
  *
 * EXCLUDED-FROM-VERIFY: advisory GO/NO-GO for a live demo, not a correctness gate. It fails when the
 * model balance is low or a workspace has no documents — true facts about the
 * environment that must not turn the build red.
 */
const path = require('path');
const { execFileSync } = require('child_process');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const args = process.argv.slice(2);
const ORG = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;
const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const blockers = [];
const warnings = [];
const ok = [];

const stop = (what, why, fix) => blockers.push({ what, why, fix });
const warn = (what, why, fix) => warnings.push({ what, why, fix });
const good = (what, detail) => ok.push({ what, detail });

async function http(pathname) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(15000) });
    return { status: res.status, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, ms: Date.now() - started, error: e.message };
  }
}

(async () => {
  await db.connect();
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  DEMO READY?                                             ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  try {
    // ── 1. CAN IT ANSWER AT ALL ──────────────────────────────────────────────
    // The only failure that cannot be talked around. Everything else you can
    // narrate past; silence in front of an investor you cannot.
    let balance = null;
    try {
      const out = execFileSync(process.execPath, [path.join(__dirname, 'spend-guard.js')],
        { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
      const m = out.match(/balance[^-\d]*(-?\d+(?:\.\d+)?)/i);
      if (m) balance = Number(m[1]);
    } catch (e) {
      const out = `${e.stdout || ''}${e.stderr || ''}`;
      const m = out.match(/balance[^-\d]*(-?\d+(?:\.\d+)?)/i);
      if (m) balance = Number(m[1]);
    }

    if (balance === null) {
      warn('Model credit', 'could not read the provider balance',
        'run spend-guard.js by hand before you present');
    } else if (balance <= 0) {
      stop('THE AGENT CANNOT ANSWER', `provider balance is ${balance}`,
        'top up OpenRouter. Nothing else on this list matters until you do.');
    } else if (balance < 5) {
      warn('Model credit is thin', `balance is ${balance}`,
        'a long demo can exhaust this mid-sentence — top up further');
    } else {
      good('The agent can answer', `balance ${balance}`);
    }

    // ── 2. IS THE MACHINE UP ─────────────────────────────────────────────────
    const pages = [
      ['/api/health', 'health probe'],
      ['/', 'the page you open first'],
      ['/conversations', 'the inbox'],
      ['/brain', 'what it knows'],
    ];
    for (const [p, label] of pages) {
      const r = await http(p);
      if (r.status === 0) {
        stop(`${label} is unreachable`, r.error || 'no response', 'the stack is down — start it');
      } else if (r.status >= 500) {
        stop(`${label} returns ${r.status}`, 'a server error mid-demo', 'check the dashboard logs');
      } else if (r.ms > 3000) {
        warn(`${label} is slow`, `${r.ms}ms`, 'first load after a restart is slow — open it once beforehand');
      } else {
        good(label, `${r.status} in ${r.ms}ms`);
      }
    }

    // ── 3. DOES THE WORKSPACE LOOK REAL ──────────────────────────────────────
    // An investor reads the org name before they read anything else.
    const orgRow = ORG
      ? (await db.query(`SELECT id, name FROM orgs WHERE id = $1`, [ORG])).rows[0]
      : (await db.query(
        `SELECT o.id, o.name FROM orgs o
          ORDER BY (SELECT COUNT(*) FROM conversations c WHERE c.org_id = o.id) DESC
          LIMIT 1`)).rows[0];

    if (!orgRow) {
      stop('No workspace to show', 'there are no orgs', 'seed one');
    } else {
      const id = orgRow.id;
      const name = String(orgRow.name || '');
      /^[a-z]_\d|Organization$|^test|^demo-\d/i.test(name)
        ? warn('The workspace name looks like a test fixture', `"${name}"`,
          'rename it to a plausible business before you share your screen')
        : good('Workspace name', `"${name}"`);

      const stat = async (sql) => Number((await db.query(sql, [id])).rows[0].n);
      const convs = await stat('SELECT COUNT(*)::int AS n FROM conversations WHERE org_id = $1');
      const mem = await stat('SELECT COUNT(*)::int AS n FROM org_memory WHERE org_id = $1');
      const emps = await stat('SELECT COUNT(*)::int AS n FROM ai_employees WHERE org_id = $1');

      convs >= 5 ? good('Conversations to show', `${convs}`)
        : warn('Almost no conversations', `${convs}`, 'an empty inbox demos badly');
      mem >= 3 ? good('Things it knows', `${mem} memory rows`)
        : stop('It knows nothing', `${mem} memory rows in this workspace`,
          'the agent will refuse or hedge every factual question — put real '
          + 'documents or typed facts in Brain first');
      emps >= 1 ? good('Employees', `${emps}`)
        : warn('No employees', '0', 'the employees page will be empty');

      // ── 4. DOES IT DO WHAT YOU WILL SAY IT DOES ───────────────────────────
      const shadow = (await db.query(
        `SELECT enabled FROM org_shadow_mode WHERE org_id = $1`, [id])).rows[0];
      const on = Boolean(shadow?.enabled);
      console.log(`  Shadow mode for this workspace: ${on ? 'ON — it drafts, you send' : 'OFF — it sends'}\n`);
      good('Shadow mode state is known', on ? 'ON' : 'OFF');
      if (!on) {
        warn('Shadow mode is OFF', 'the agent will send replies to real customers',
          'if you plan to say "nothing goes out without a human", switch it on first');
      }
    }
  } finally {
    await db.end().catch(() => {});
  }

  // ── The verdict ──────────────────────────────────────────────────────────
  for (const g of ok) console.log(`  [ ok ]  ${g.what}${g.detail ? ` — ${g.detail}` : ''}`);
  if (warnings.length) {
    console.log('');
    for (const w of warnings) {
      console.log(`  [warn]  ${w.what} — ${w.why}`);
      console.log(`          → ${w.fix}`);
    }
  }
  if (blockers.length) {
    console.log('');
    for (const b of blockers) {
      console.log(`  [STOP]  ${b.what} — ${b.why}`);
      console.log(`          → ${b.fix}`);
    }
  }

  console.log('\n  ───');
  if (blockers.length) {
    console.log(`\n  NO-GO — ${blockers.length} thing(s) will break in front of people.\n`);
    process.exit(1);
  }
  console.log(`\n  GO${warnings.length ? ` — with ${warnings.length} thing(s) worth fixing first` : ''}.\n`);
  process.exit(0);
})().catch(async (e) => {
  console.log(`\n  ERROR: ${e.message}\n`);
  try { await db.end(); } catch { /* closed */ }
  process.exit(1);
});
