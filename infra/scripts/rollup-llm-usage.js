#!/usr/bin/env node
'use strict';
/**
 * ROLL UP LLM USAGE — turn the proxy's spend log into a per-tenant meter.
 *
 * LiteLLM writes every call to its own database, attributed to a tenant by the
 * `end_user` column (which is only populated because commits 4525f28, 41e48c1
 * and 85373dc threaded the org through all six worker call sites). That table
 * is the wrong shape to read on the hot path: it grows without bound, lives in
 * a different database from the tenant data, and has no RLS.
 *
 * So this job aggregates it — by tenant, day and model — into
 * org_llm_usage_daily, which is small, indexed, RLS-protected and local to the
 * budget check.
 *
 * IDEMPOTENT BY CONSTRUCTION. It recomputes whole days from the source and the
 * upsert assigns rather than adds (see migration 036). Running it twice, or
 * running it while a previous run is still going, cannot inflate a tenant's
 * consumption — which matters, because an inflated figure silently throttles a
 * paying customer.
 *
 * WHAT IT DELIBERATELY DOES NOT COPY
 * No prompts, no completions, no contact data. Only counts. Metering does not
 * need message content, and copying it here would turn the billing subsystem
 * into a second, separately-retained store of every conversation.
 *
 * Usage:
 *   node infra/scripts/rollup-llm-usage.js            last 2 days
 *   node infra/scripts/rollup-llm-usage.js --days 30  backfill
 *   node infra/scripts/rollup-llm-usage.js --self-test
 *
 * Exit: 0 = rolled up, 1 = failed.
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this end_user value a real tenant?
 *
 * The column also holds probe labels ("attribution-probe-1787962891919") and
 * empty strings from before attribution was fixed. Those are not tenants and
 * must not become rows: a non-UUID would fail the foreign key and abort the
 * whole rollup, so they are dropped here rather than at the database.
 */
function isTenant(endUser) {
  return typeof endUser === 'string' && UUID_RE.test(endUser.trim());
}

/**
 * Normalise a day to YYYY-MM-DD.
 *
 * node-postgres parses a `date` column into a JS Date at LOCAL midnight, and
 * handing that straight back to a query serialises it as
 * "Sat Aug 29 2026 00:00:00 GMT+0530", which Postgres refuses.
 *
 * The obvious repair — toISOString().slice(0, 10) — is worse than the bug,
 * because it converts to UTC first: local midnight in IST is 18:30 the PREVIOUS
 * day in UTC, so every date would silently shift back one day. At a month
 * boundary that moves a tenant's consumption into the wrong budget period and
 * resets their allowance a day early.
 *
 * So the local components are read directly, which round-trips the value the
 * database actually sent.
 */
function toIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // Already a string: keep only the date part, so an ISO timestamp is safe too.
  return String(value).slice(0, 10);
}

/**
 * Fold raw spend-log rows into one row per (org, day, model).
 *
 * Pure, so the grouping and the failure accounting can be tested without a
 * database. A failed call contributes to `calls` and `failures` but never to
 * token totals — a request that produced nothing must not consume budget, and
 * LiteLLM records 0 tokens for those anyway.
 */
function foldUsage(rows) {
  const out = new Map();
  let skipped = 0;
  for (const r of rows || []) {
    if (!isTenant(r.end_user)) { skipped++; continue; }
    const orgId = String(r.end_user).trim();
    const day = toIsoDate(r.usage_date);
    const model = String(r.model || 'unknown');
    const key = `${orgId}|${day}|${model}`;
    const cur = out.get(key) || {
      orgId, day, model,
      calls: 0, prompt: 0, completion: 0, total: 0, failures: 0,
    };
    const failed = String(r.status || '').toLowerCase() === 'failure';
    const n = (v) => {
      const x = Number(v);
      return Number.isFinite(x) && x > 0 ? x : 0;
    };
    cur.calls += n(r.calls) || 1;
    if (failed) {
      cur.failures += n(r.calls) || 1;
    } else {
      cur.prompt += n(r.prompt_tokens);
      cur.completion += n(r.completion_tokens);
      cur.total += n(r.total_tokens);
    }
    out.set(key, cur);
  }
  return { rows: [...out.values()], skipped };
}

// ── Self-test ───────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  const assert = require('assert');
  let pass = 0;
  let fail = 0;
  const t = (name, fn) => {
    try { fn(); pass++; console.log(`  [PASS] ${name}`); }
    catch (e) { fail++; console.log(`  [FAIL] ${name} — ${e.message}`); }
  };
  const ORG = '8ac7bf25-0b47-487e-aa09-3c6e7657978e';

  console.log('\n=== USAGE ROLLUP — SELF TEST ===\n');

  t('groups by org, day and model', () => {
    const { rows } = foldUsage([
      { end_user: ORG, usage_date: '2026-08-29', model: 'm1', calls: 1, total_tokens: 100, status: 'success' },
      { end_user: ORG, usage_date: '2026-08-29', model: 'm1', calls: 1, total_tokens: 50, status: 'success' },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].total, 150);
    assert.equal(rows[0].calls, 2);
  });

  t('a different model is a different row', () => {
    const { rows } = foldUsage([
      { end_user: ORG, usage_date: '2026-08-29', model: 'paid', calls: 1, total_tokens: 100, status: 'success' },
      { end_user: ORG, usage_date: '2026-08-29', model: 'free', calls: 1, total_tokens: 900, status: 'success' },
    ]);
    assert.equal(rows.length, 2, 'free volume must stay visible separately from paid');
  });

  t('SAFETY: a non-tenant end_user is dropped, not inserted', () => {
    const { rows, skipped } = foldUsage([
      { end_user: 'attribution-probe-1787962891919', usage_date: '2026-08-29', model: 'm', total_tokens: 43, status: 'success' },
      { end_user: '', usage_date: '2026-08-29', model: 'm', total_tokens: 99, status: 'success' },
      { end_user: null, usage_date: '2026-08-29', model: 'm', total_tokens: 99, status: 'success' },
    ]);
    assert.equal(rows.length, 0, 'a probe label is not a tenant');
    assert.equal(skipped, 3);
  });

  t('a failed call counts as a call but consumes no budget', () => {
    const { rows } = foldUsage([
      { end_user: ORG, usage_date: '2026-08-29', model: 'm', calls: 1, total_tokens: 0, status: 'failure' },
      { end_user: ORG, usage_date: '2026-08-29', model: 'm', calls: 1, total_tokens: 500, status: 'success' },
    ]);
    assert.equal(rows[0].calls, 2);
    assert.equal(rows[0].failures, 1);
    assert.equal(rows[0].total, 500, 'a 402 must not be billed to the tenant');
  });

  t('SAFETY: rubbish token counts are treated as zero, never as NaN', () => {
    const { rows } = foldUsage([
      { end_user: ORG, usage_date: '2026-08-29', model: 'm', calls: 1, total_tokens: null, status: 'success' },
      { end_user: ORG, usage_date: '2026-08-29', model: 'm', calls: 1, total_tokens: 'abc', status: 'success' },
      { end_user: ORG, usage_date: '2026-08-29', model: 'm', calls: 1, total_tokens: -5, status: 'success' },
    ]);
    assert.equal(rows[0].total, 0);
    assert.ok(Number.isFinite(rows[0].total));
  });

  t('IDEMPOTENCE: folding the same input twice yields the same totals', () => {
    const input = [
      { end_user: ORG, usage_date: '2026-08-29', model: 'm', calls: 1, total_tokens: 100, status: 'success' },
    ];
    const a = foldUsage(input).rows[0].total;
    const b = foldUsage(input).rows[0].total;
    assert.equal(a, b, 'the fold must not accumulate across calls');
  });

  t('a Date from pg becomes YYYY-MM-DD and does not shift a day', () => {
    // Local midnight on the 29th. In IST, toISOString() would render this as
    // the 28th, moving usage into the previous month at a boundary.
    const local = new Date(2026, 7, 29, 0, 0, 0);
    const { rows } = foldUsage([
      { end_user: ORG, usage_date: local, model: 'm', calls: 1, total_tokens: 10, status: 'success' },
    ]);
    assert.equal(rows[0].day, '2026-08-29');
  });

  t('a month boundary does not roll backwards', () => {
    const firstOfMonth = new Date(2026, 8, 1, 0, 0, 0);
    const { rows } = foldUsage([
      { end_user: ORG, usage_date: firstOfMonth, model: 'm', calls: 1, total_tokens: 10, status: 'success' },
    ]);
    assert.equal(rows[0].day, '2026-09-01', 'a day-shift here resets a budget early');
  });

  t('a string date is passed through unchanged', () => {
    const { rows } = foldUsage([
      { end_user: ORG, usage_date: '2026-08-29', model: 'm', calls: 1, total_tokens: 10, status: 'success' },
    ]);
    assert.equal(rows[0].day, '2026-08-29');
  });

  t('an empty log produces no rows and does not throw', () => {
    assert.deepEqual(foldUsage([]).rows, []);
    assert.deepEqual(foldUsage(null).rows, []);
  });

  console.log(`\n  passed ${pass} / ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
}

// ── Live rollup ─────────────────────────────────────────────────────────────
const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg > -1 ? Math.max(1, parseInt(process.argv[daysArg + 1], 10) || 2) : 2;

const dbCfg = (database) => ({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database,
});

(async () => {
  const litellm = new Client(dbCfg('litellm'));
  const darex = new Client(dbCfg(process.env.DB_NAME || 'darex'));
  await litellm.connect();
  await darex.connect();

  // Pin the session timezone.
  //
  // node-postgres forwards the process timezone, and on this Windows host that
  // arrives as "GMT+0530", which Postgres rejects outright — the rollup failed
  // with `time zone "gmt+0530" not recognized` before this line existed.
  // Pinning it also makes the day boundary a property of the code rather than
  // of whichever machine runs the job, so the same spend log always buckets
  // into the same days.
  await litellm.query("SET TIME ZONE 'UTC'");
  await darex.query("SET TIME ZONE 'UTC'");

  try {
    const res = await litellm.query(
      `SELECT ("startTime" AT TIME ZONE 'UTC')::date AS usage_date,
              end_user,
              model,
              status,
              COUNT(*)                        AS calls,
              SUM(prompt_tokens)              AS prompt_tokens,
              SUM(completion_tokens)          AS completion_tokens,
              SUM(total_tokens)               AS total_tokens
         FROM "LiteLLM_SpendLogs"
        WHERE "startTime" >= NOW() - ($1 || ' days')::interval
        GROUP BY 1, 2, 3, 4`,
      [String(DAYS)],
    );

    const { rows, skipped } = foldUsage(res.rows);

    let written = 0;
    for (const r of rows) {
      await darex.query(
        `SELECT record_llm_usage($1::uuid, $2::date, $3::text,
                                 $4::bigint, $5::bigint, $6::bigint, $7::bigint, $8::bigint)`,
        [r.orgId, r.day, r.model, r.calls, r.prompt, r.completion, r.total, r.failures],
      );
      written++;
    }

    const tokens = rows.reduce((a, r) => a + r.total, 0);
    const orgs = new Set(rows.map((r) => r.orgId)).size;
    console.log(
      `rolled up ${written} row(s) — ${orgs} workspace(s), ` +
      `${tokens.toLocaleString('en-IN')} tokens over ${DAYS} day(s)` +
      (skipped ? `; ${skipped} unattributed source row(s) skipped` : ''),
    );
    // Surfaced rather than swallowed: unattributed rows are the signal that a
    // call path has lost its tenant again, which is how this whole problem
    // started. A silent skip would hide the next regression.
    if (skipped) {
      console.log('  NOTE: unattributed rows are pre-fix history or probes. A rising count means a new call site is missing `user`.');
    }
  } finally {
    await litellm.end().catch(() => {});
    await darex.end().catch(() => {});
  }
})().catch((e) => {
  console.error(`rollup failed: ${e.message}`);
  process.exit(1);
});

module.exports = { foldUsage, isTenant };
