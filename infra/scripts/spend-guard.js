#!/usr/bin/env node
'use strict';
/**
 * SPEND GUARD — how many days of LLM budget are left, and is it accelerating?
 *
 * WHY THIS EXISTS
 * The OpenRouter balance hit zero mid-run and 11 of 12 test conversations got
 * no reply. There was no warning: the balance is not visible from inside the
 * product, and the first symptom was silence. Preflight now catches an already
 * empty wallet — this catches the wallet that will be empty on Thursday, which
 * is the only version of the warning an operator can act on.
 *
 * THE TRAP THIS DELIBERATELY AVOIDS
 * The obvious implementation reads LiteLLM_SpendLogs.spend and sums it. Those
 * numbers are wrong here, in the direction that gets you hurt: over the last
 * 7 days LiteLLM recorded $0.0032 across ~2,300 calls while OpenRouter charged
 * roughly $14. LiteLLM prices calls from its own model table, which has no
 * correct entry for these OpenRouter routes, and correctly records $0.00 for
 * the :free tier — which carried 40 million tokens in that window. An alarm
 * built on that column reports "spending nothing" right until everything stops.
 *
 * So money comes from the PROVIDER and volume comes from LiteLLM, which counts
 * calls and tokens accurately. Consecutive provider readings (migration 027)
 * give a real burn rate; burn rate against balance gives runway in days.
 *
 * Usage:
 *   node infra/scripts/spend-guard.js              record a sample and report
 *   node infra/scripts/spend-guard.js --no-record  report without writing
 *   node infra/scripts/spend-guard.js --json       machine-readable
 *
 * Exit: 0 = fine, 1 = the budget will not survive the next day of this usage.
 *
 * Meant to run on a schedule — hourly is plenty. Each run is one HTTPS request
 * and two small queries, and costs nothing in tokens.
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const RECORD = !process.argv.includes('--no-record');
const AS_JSON = process.argv.includes('--json');

/** Below this many days of runway, someone has to act today. */
const RUNWAY_CRITICAL_DAYS = 1;
const RUNWAY_WARN_DAYS = 3;

function db(database) {
  return new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_RESOLVER_USER || 'darex',
    password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
    database,
  });
}

async function readProvider() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, reason: 'OPENROUTER_API_KEY is not set' };
  try {
    const r = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const b = await r.json().catch(() => ({}));
    if (!b.data) return { ok: false, reason: `HTTP ${r.status}` };
    const credits = Number(b.data.total_credits);
    const usage = Number(b.data.total_usage);
    return { ok: true, credits, usage, remaining: credits - usage };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).slice(0, 80) };
  }
}

/** Call and token counts from LiteLLM. Accurate; its `spend` column is not. */
async function readVolume() {
  const c = db('litellm');
  try {
    await c.connect();
    const r = await c.query(`
      SELECT
        COUNT(*)::bigint                                              AS calls_total,
        COALESCE(SUM(total_tokens), 0)::bigint                        AS tokens_total,
        COUNT(*) FILTER (WHERE "startTime" > NOW() - INTERVAL '24 hours')::bigint AS calls_24h,
        COALESCE(SUM(total_tokens) FILTER (WHERE "startTime" > NOW() - INTERVAL '24 hours'), 0)::bigint AS tokens_24h
      FROM "LiteLLM_SpendLogs"`);
    // Which tier is actually carrying traffic. A sudden shift to the free tier
    // means the paid tiers are failing, and that is the first visible symptom
    // of an empty balance.
    const mix = await c.query(`
      SELECT model_group, COUNT(*)::bigint AS calls
      FROM "LiteLLM_SpendLogs"
      WHERE "startTime" > NOW() - INTERVAL '24 hours' AND COALESCE(model_group, '') <> ''
      GROUP BY 1 ORDER BY calls DESC`);
    await c.end();
    return { ok: true, ...r.rows[0], mix: mix.rows };
  } catch (e) {
    try { c.removeAllListeners(); } catch { /* never opened */ }
    return { ok: false, reason: String(e.message || e).slice(0, 80) };
  }
}

/**
 * Burn rate from consecutive provider readings.
 *
 * Deliberately uses the OLDEST sample within the window rather than only the
 * previous one: a single pair of adjacent samples an hour apart turns one busy
 * hour into an alarming daily rate, and one idle hour into a reassuring one.
 */
function burnRate(rows) {
  if (rows.length < 2) return { known: false, reason: 'need a second sample — run this again later' };
  const newest = rows[0];
  const oldest = rows[rows.length - 1];
  const spent = Number(newest.total_usage) - Number(oldest.total_usage);
  const hours = (new Date(newest.taken_at) - new Date(oldest.taken_at)) / 3_600_000;
  if (hours <= 0) return { known: false, reason: 'samples share a timestamp' };
  // Under an hour of history, a rate extrapolated to a day is noise wearing a
  // decimal point. Report the span instead of inventing confidence.
  if (hours < 1) return { known: false, reason: `only ${Math.round(hours * 60)} minutes of history so far` };
  return { known: true, perDay: (spent / hours) * 24, spanHours: hours, spent };
}

// ── Self-test ───────────────────────────────────────────────────────────────
// burnRate is the one piece of real arithmetic here and it never runs on a
// fresh deployment (two samples an hour apart are needed), so it would sit
// unexercised until the day it mattered. These cases run it against fabricated
// rows in memory — no database, no provider, no tokens.
// Run: node infra/scripts/spend-guard.js --self-test
if (process.argv.includes('--self-test')) {
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  let pass = 0;
  let fail = 0;
  const check = (label, cond, detail = '') => {
    if (cond) { pass++; console.log(`  [PASS] ${label}`); }
    else { fail++; console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`); }
  };

  console.log('\n### SPEND GUARD SELF-TEST\n');

  // An unreadable balance must EXIT NON-ZERO. This shipped exiting 0, and a
  // single transient failure of the OpenRouter call made the budget alarm
  // report green over an empty wallet — a full verify run came back
  // "18 of 18 suites passed" on a deployment at -$0.20. Asserted as a
  // subprocess because the exit code is the whole behaviour.
  {
    const r = require('child_process').spawnSync(
      process.execPath, [__filename, '--no-record'],
      {
        encoding: 'utf8',
        env: { ...process.env, OPENROUTER_API_KEY: 'sk-or-v1-definitely-not-a-real-key-000000' },
      },
    );
    check('an UNREADABLE balance exits non-zero', r.status === 1,
      `exit ${r.status} — "cannot tell" must never report as "fine"`);
    check('and says so in words', /unreadable/i.test(`${r.stdout}${r.stderr}`));
  }

  const none = burnRate([]);
  check('no samples is honest, not zero', none.known === false);

  const one = burnRate([{ total_usage: '5', taken_at: hoursAgo(0) }]);
  check('a single sample cannot imply a rate', one.known === false);

  const tooFresh = burnRate([
    { total_usage: '6', taken_at: hoursAgo(0) },
    { total_usage: '5', taken_at: hoursAgo(0.25) },
  ]);
  check('15 minutes of history is refused, not extrapolated', tooFresh.known === false, tooFresh.reason);

  // $6 over 12 hours = $12/day.
  const real = burnRate([
    { total_usage: '18', taken_at: hoursAgo(0) },
    { total_usage: '15', taken_at: hoursAgo(6) },
    { total_usage: '12', taken_at: hoursAgo(12) },
  ]);
  check('a real rate is computed from the OLDEST sample, not the previous one',
    real.known && Math.abs(real.perDay - 12) < 0.001, `got ${real.perDay}`);
  check('the spend delta spans the whole window',
    real.known && Math.abs(real.spent - 6) < 0.001, `got ${real.spent}`);

  // The reason the oldest sample is used: one quiet recent hour must not be
  // read as the whole story. Adjacent-pair maths would report $0/day here.
  const quietRecentHour = burnRate([
    { total_usage: '18', taken_at: hoursAgo(0) },
    { total_usage: '18', taken_at: hoursAgo(1) },
    { total_usage: '12', taken_at: hoursAgo(12) },
  ]);
  check('one idle hour does not erase a day of spending',
    quietRecentHour.known && quietRecentHour.perDay > 10, `got ${quietRecentHour.perDay}`);

  const identical = burnRate([
    { total_usage: '5', taken_at: hoursAgo(2) },
    { total_usage: '5', taken_at: hoursAgo(2) },
  ]);
  check('identical timestamps do not divide by zero', identical.known === false);

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
}

(async () => {
  const provider = await readProvider();
  const volume = await readVolume();

  let samples = [];
  const store = db(process.env.DB_NAME || 'darex');
  try {
    await store.connect();
    if (RECORD && provider.ok) {
      await store.query(
        `INSERT INTO provider_spend_snapshots
           (provider, total_usage, total_credits, calls, tokens)
         VALUES ('openrouter', $1, $2, $3, $4)`,
        [provider.usage, provider.credits, volume.ok ? volume.calls_total : null,
          volume.ok ? volume.tokens_total : null],
      );
    }
    const r = await store.query(
      `SELECT total_usage, total_credits, calls, tokens, taken_at
       FROM provider_spend_snapshots
       WHERE provider = 'openrouter' AND taken_at > NOW() - INTERVAL '7 days'
       ORDER BY taken_at DESC LIMIT 200`);
    samples = r.rows;
    await store.end();
  } catch (e) {
    try { store.removeAllListeners(); } catch { /* never opened */ }
    samples = [];
    if (!AS_JSON) console.log(`  [WARN] could not reach the snapshot table — ${String(e.message || e).slice(0, 70)}`);
  }

  const burn = burnRate(samples);
  const remaining = provider.ok ? provider.remaining : null;
  const runwayDays = burn.known && burn.perDay > 0 && remaining !== null
    ? remaining / burn.perDay
    : null;

  // Cost per call from the provider's money and LiteLLM's counts — neither
  // source can produce this alone.
  let costPerCall = null;
  if (burn.known && volume.ok && samples.length >= 2) {
    const callsDelta = Number(samples[0].calls) - Number(samples[samples.length - 1].calls);
    if (callsDelta > 0) costPerCall = burn.spent / callsDelta;
  }

  const verdict = (() => {
    // UNKNOWN IS NOT OK, and this exits non-zero for it.
    //
    // It used to exit 0. One transient failure of the OpenRouter call — a
    // timeout, a 401 on a rotated key, a rate limit — and the budget alarm
    // reported green while the balance sat at -$0.20. It was caught exactly
    // that way: a full verify run came back "18 of 18 suites passed" on a
    // deployment whose wallet was empty.
    //
    // "I cannot tell whether you have money" is not "you have money". An alarm
    // that cannot measure must never report the thing it failed to measure as
    // fine, because a green it did not earn is worse than no alarm at all —
    // the operator stops looking.
    if (!provider.ok) return { level: 'unknown', line: `provider balance unreadable — ${provider.reason}` };
    if (remaining <= 0) return { level: 'critical', line: `balance is EXHAUSTED ($${remaining.toFixed(2)})` };
    if (runwayDays !== null && runwayDays < RUNWAY_CRITICAL_DAYS) {
      return { level: 'critical', line: `under ${RUNWAY_CRITICAL_DAYS} day of budget left at the current rate` };
    }
    if (runwayDays !== null && runwayDays < RUNWAY_WARN_DAYS) {
      return { level: 'warn', line: `${runwayDays.toFixed(1)} days of budget left at the current rate` };
    }
    if (remaining < 1) return { level: 'warn', line: `$${remaining.toFixed(2)} left — roughly a handful of conversations` };
    return { level: 'ok', line: runwayDays === null ? 'balance healthy' : `${runwayDays.toFixed(1)} days of budget at the current rate` };
  })();

  if (AS_JSON) {
    console.log(JSON.stringify({
      verdict: verdict.level,
      message: verdict.line,
      remaining,
      burnPerDay: burn.known ? burn.perDay : null,
      runwayDays,
      costPerCall,
      samples: samples.length,
      calls24h: volume.ok ? Number(volume.calls_24h) : null,
      tokens24h: volume.ok ? Number(volume.tokens_24h) : null,
      mix: volume.ok ? volume.mix.map((m) => ({ tier: m.model_group, calls: Number(m.calls) })) : [],
    }, null, 2));
    // 'unknown' exits non-zero too: a balance we could not read is not a
  // balance we can vouch for. See the verdict block above.
  process.exit(verdict.level === 'critical' || verdict.level === 'unknown' ? 1 : 0);
  }

  const money = (n) => (n === null || n === undefined ? '—' : `$${Number(n).toFixed(4)}`);
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  DAREX SPEND GUARD — how long does the budget last?          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('PROVIDER (authoritative for money)');
  if (provider.ok) {
    console.log(`  balance remaining      ${money(provider.remaining)}`);
    console.log(`  lifetime usage         ${money(provider.usage)} of ${money(provider.credits)} granted`);
  } else {
    console.log(`  unreadable             ${provider.reason}`);
  }

  console.log('\nBURN RATE');
  if (burn.known) {
    console.log(`  measured over          ${burn.spanHours.toFixed(1)} h across ${samples.length} samples`);
    console.log(`  spent in that window   ${money(burn.spent)}`);
    console.log(`  extrapolated per day   ${money(burn.perDay)}`);
    console.log(`  runway                 ${runwayDays === null ? '—' : `${runwayDays.toFixed(1)} days`}`);
    if (costPerCall !== null) console.log(`  cost per LLM call      ${money(costPerCall)}`);
  } else {
    console.log(`  not yet measurable     ${burn.reason}`);
  }

  console.log('\nVOLUME (from LiteLLM — counts are accurate, its cost column is not)');
  if (volume.ok) {
    console.log(`  calls in 24 h          ${volume.calls_24h}`);
    console.log(`  tokens in 24 h         ${Number(volume.tokens_24h).toLocaleString('en-US')}`);
    for (const m of volume.mix) {
      // A tier serving traffic it normally does not is the earliest visible
      // sign that the tiers above it are failing.
      console.log(`    ${String(m.model_group).padEnd(24)} ${m.calls} calls`);
    }
  } else {
    console.log(`  unreadable             ${volume.reason}`);
  }

  const badge = { ok: '  OK  ', warn: ' WARN ', critical: 'CRITICAL', unknown: 'UNKNOWN' }[verdict.level];
  console.log('\n' + '─'.repeat(64));
  console.log(`\n  [${badge}]  ${verdict.line}\n`);
  if (verdict.level === 'critical') {
    console.log('  Top up at https://openrouter.ai/credits, or add a second payment');
    console.log('  rail (DEEPSEEK_API_KEY / GROQ_API_KEY) so one empty wallet cannot');
    console.log('  take every tier down at once.\n');
  }
  // 'unknown' exits non-zero too: a balance we could not read is not a
  // balance we can vouch for. See the verdict block above.
  process.exit(verdict.level === 'critical' || verdict.level === 'unknown' ? 1 : 0);
})();
