#!/usr/bin/env node
'use strict';
/**
 * GIVE THE EXISTING MEMORY ITS VECTORS.
 *
 * Retrieval is hybrid — keyword `tsvector` first, cosine similarity when a
 * query vector is available. The cosine half has never run here: EMBEDDING_MODEL
 * was empty, so `embedQuery` returned null on every call and every row was
 * written with a NULL embedding. Measured before this script: 0 of 1,154 rows
 * had a vector.
 *
 * Keyword-only retrieval finds a fact when the customer happens to use the
 * document's own words, and misses it otherwise. That is most of what "the agent
 * doesn't know things" actually means.
 *
 * Setting the key fixes NEW rows. Everything already ingested stays blind until
 * something walks back over it, which is this.
 *
 * ── WHY IT CHECKS THE DIMENSION ON EVERY ROW ────────────────────────────────
 *
 * `gemini-embedding-001` returns 3072 dimensions by default; the column is
 * `vector(1536)` and `retrieve.ts` silently discards any vector of the wrong
 * length. So a misconfigured run would succeed on every call, write nothing
 * usable, and report success. The dimension is asserted per row and the run
 * stops on the first mismatch rather than filling the table with rejects.
 *
 * Resumable: only rows with a NULL embedding are read, so an interrupted run
 * continues where it stopped. Safe to re-run.
 *
 * Usage:
 *   node infra/scripts/backfill-embeddings.js            # all orgs
 *   node infra/scripts/backfill-embeddings.js --limit 50 # a taste first
 *   node infra/scripts/backfill-embeddings.js --org <uuid>
 */
const path = require('path');
require('./lib/env').loadRepoEnv();

const ROOT = path.join(__dirname, '..', '..');
let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(ROOT, 'apps/dashboard/node_modules/pg')).Client; }

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const LIMIT = parseInt(argOf('--limit', '0'), 10) || 0;
const ORG = argOf('--org', '');
const BATCH = parseInt(process.env.BACKFILL_BATCH || '16', 10);
const DIM = parseInt(process.env.EMBEDDING_DIM || '1536', 10);
const MODEL = process.env.EMBEDDING_MODEL || '';
const BASE = (process.env.LITELLM_BASE_URL || 'http://127.0.0.1:4000/v1').replace(/\/$/, '');
const KEY = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

const embedUrl = () => (BASE.endsWith('/v1') ? `${BASE}/embeddings` : `${BASE}/v1/embeddings`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A 429 here is a per-MINUTE quota, not a wall.
 *
 * Measured on the Gemini free tier: 368 of 1,154 rows embedded, then every
 * remaining batch failed with "You exceeded your current quota". Without
 * backoff the run burns through the rest of the table in seconds, reports 786
 * failures, and leaves the operator thinking the key is wrong. The quota
 * refills on its own; the script simply has to wait for it.
 */
async function embed(texts, attempt = 0) {
  const res = await fetch(embedUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (res.status === 429 && attempt < 6) {
    // 15s, 30s, 60s, 120s, 240s, 480s. A free-tier minute quota clears well
    // inside the first two.
    const waitMs = 15000 * 2 ** attempt;
    process.stdout.write(`  rate limited, waiting ${Math.round(waitMs / 1000)}s   `);
    await sleep(waitMs);
    return embed(texts, attempt + 1);
  }
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const out = (data.data || []).map((d) => d.embedding);
  if (out.length !== texts.length) throw new Error(`asked for ${texts.length} vectors, got ${out.length}`);
  for (const v of out) {
    if (!Array.isArray(v) || v.length !== DIM) {
      throw new Error(
        `dimension mismatch: got ${Array.isArray(v) ? v.length : typeof v}, column is vector(${DIM}). `
        + 'Pin `dimensions` on the embedding model in infra/litellm/config.yaml — '
        + 'a wrong-length vector is written and then silently ignored by retrieval.'
      );
    }
  }
  return out;
}

(async () => {
  console.log('\n=== BACKFILL EMBEDDINGS ===\n');

  if (!MODEL) {
    console.log('  EMBEDDING_MODEL is not set. Nothing to do — set it, then re-run.');
    process.exit(1);
  }
  if (!KEY) {
    console.log('  No LiteLLM key in the environment. Nothing to do.');
    process.exit(1);
  }
  console.log(`  model ${MODEL}  dim ${DIM}  batch ${BATCH}`);

  await db.connect();

  const where = ['embedding IS NULL', "coalesce(body,'') <> ''"];
  const params = [];
  if (ORG) { params.push(ORG); where.push(`org_id = $${params.length}::uuid`); }

  const total = (await db.query(
    `SELECT count(*)::int AS n FROM org_memory WHERE ${where.join(' AND ')}`, params
  )).rows[0].n;
  console.log(`  ${total} row(s) without a vector\n`);
  if (total === 0) { await db.end(); console.log('  Nothing to do.\n'); process.exit(0); }

  let done = 0;
  let failed = 0;
  const target = LIMIT > 0 ? Math.min(LIMIT, total) : total;

  while (done + failed < target) {
    const take = Math.min(BATCH, target - done - failed);
    const rows = (await db.query(
      `SELECT id, coalesce(title,'') AS title, body FROM org_memory
        WHERE ${where.join(' AND ')} ORDER BY created_at LIMIT ${take}`, params
    )).rows;
    if (rows.length === 0) break;

    // Same text retrieval scores against: the title only when the body does not
    // already start with it, matching the snippet rule in retrieve.ts.
    const texts = rows.map((r) => {
      const t = String(r.title || '');
      const b = String(r.body || '');
      const combined = t && !b.startsWith(t) ? `${t}\n${b}` : b;
      return combined.slice(0, 8000);
    });

    let vectors;
    try {
      vectors = await embed(texts);
    } catch (err) {
      console.log(`  [FAIL] ${err.message}`);
      // A dimension mismatch will not fix itself on the next batch, and every
      // further call would spend tokens producing rows retrieval throws away.
      if (/dimension mismatch/.test(err.message)) { failed = target; break; }
      failed += rows.length;
      continue;
    }

    for (let i = 0; i < rows.length; i += 1) {
      await db.query(
        `UPDATE org_memory SET embedding = $2::vector, updated_at = updated_at WHERE id = $1`,
        [rows[i].id, `[${vectors[i].join(',')}]`]
      );
    }
    done += rows.length;
    process.stdout.write(`\r  embedded ${done}/${target}   `);
  }

  console.log('');
  const left = (await db.query(
    `SELECT count(*)::int AS n FROM org_memory WHERE ${where.join(' AND ')}`, params
  )).rows[0].n;
  const withVec = (await db.query(
    `SELECT count(*)::int AS n FROM org_memory WHERE embedding IS NOT NULL`
  )).rows[0].n;

  await db.end();
  console.log(`\n  embedded this run : ${done}`);
  if (failed) console.log(`  failed            : ${failed}`);
  console.log(`  still without     : ${left}`);
  console.log(`  total with vector : ${withVec}\n`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.log(`\nERROR: ${err && err.message}`);
  db.end().catch(() => {});
  process.exit(1);
});
