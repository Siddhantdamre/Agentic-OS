#!/usr/bin/env node
/**
 * PREFLIGHT — is this system safe to demo right now?
 *
 * Run this before showing the product to anyone. It answers one question:
 * would a customer message get a good answer in the next five minutes?
 *
 * WHY IT EXISTS
 * The OpenRouter balance hit zero mid-run and 11 of 12 cases got no reply.
 * Nothing warned first — the failure surfaced as silence, which is the worst
 * possible way to discover it and the worst possible thing for a company
 * evaluating the product to see.
 *
 * Everything here is READ-ONLY and takes seconds. It never sends a customer
 * message and never spends more than a few tokens.
 *
 * Usage: node infra/scripts/preflight.js
 * Exit:  0 = GO, 1 = NO-GO
 */
const path = require('path');
const fs = require('fs');
const { loadRepoEnv } = require('./lib/env');

// MUST run before anything reads process.env. Without it this script read no
// credentials at all and reported a confident NO-GO over a healthy system —
// see infra/scripts/lib/env.js for what that cost.
const ENV = loadRepoEnv();

let Client;
try { Client = require('pg').Client; }
catch { Client = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg')).Client; }

const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';
const LITELLM = process.env.LITELLM_URL || 'http://127.0.0.1:4000';
const LLM_KEY = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';

const blockers = [];
const warnings = [];
const ok = (m, d = '') => console.log(`  [ OK ]  ${m}${d ? `  — ${d}` : ''}`);
const warn = (m, d = '') => { warnings.push(m); console.log(`  [WARN]  ${m}${d ? `  — ${d}` : ''}`); };
const stop = (m, d = '') => { blockers.push(m); console.log(`  [STOP]  ${m}${d ? `  — ${d}` : ''}`); };

async function httpOk(url, timeoutMs = 5000) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return r.status;
  } catch { return 0; }
}

/**
 * Config landmines — settings that are wrong in a way nothing else notices.
 *
 * Neither of the two this catches produces an error anywhere: the system runs,
 * the demo looks fine, and the damage is invisible until someone asks a
 * question that needed the missing piece.
 */
function checkConfig() {
  ENV.loaded.length
    ? ok('env files loaded', ENV.loaded.join(', '))
    : warn('no env file found', 'running on shell environment only');

  for (const d of ENV.duplicates) {
    // Not cosmetic. Compose takes the LAST occurrence, so which value reaches
    // production depends on line order in a file nobody re-reads.
    const detail = `defined at line ${d.firstLine} and again at line ${d.line}`
      + ` — line ${d.line} wins${d.winnerWasEmpty ? ' and it is EMPTY' : ''}`;
    if (d.winnerWasEmpty) stop(`${d.key} is defined twice and resolves to EMPTY`, detail);
    else warn(`${d.key} is defined twice`, detail);
  }
  if (!ENV.duplicates.length) ok('no duplicate env keys', 'no value depends on line order');

  for (const s of ENV.shadowed) {
    // Harmless here only because the loader refuses to let "" beat a real
    // value. Anything reading these files naively gets the placeholder.
    warn(`${s.key} is declared empty in ${s.placeholder}`,
      `the working value comes from ${s.real} — delete the empty one`);
  }
}

/**
 * Is semantic search actually on?
 *
 * Retrieval ranks by `0.4 * keyword + 0.6 * vector`. With no embedding
 * provider that second term is always zero, so the system silently runs on
 * keyword search alone. It still answers — and answers well — but "semantic
 * search" is not a claim anyone should make on this configuration, and the
 * operator deserves to know which engine their results came from.
 */
function checkEmbeddings() {
  const model = process.env.EMBEDDING_MODEL;
  if (model === undefined || model.trim() === '') {
    warn('semantic search is OFF', 'EMBEDDING_MODEL is empty — retrieval is keyword-only');
    return false;
  }
  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
    stop('EMBEDDING_MODEL is set but no embedding provider key is',
      'embed calls will fail — set GEMINI_API_KEY or clear EMBEDDING_MODEL');
    return false;
  }
  ok('semantic search configured', model.trim());
  return true;
}

/** How much money is left, and will it survive a demo? */
async function checkCredit() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { warn('OpenRouter key not set', 'relying entirely on direct-provider tiers'); return; }
  try {
    const r = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const b = await r.json().catch(() => ({}));
    if (!b.data) { warn('could not read OpenRouter balance', `HTTP ${r.status}`); return; }
    const left = Number(b.data.total_credits) - Number(b.data.total_usage);
    const shown = `$${left.toFixed(2)} remaining`;
    // A demo conversation costs roughly 5-7 cents at observed usage, so a
    // dollar is about fifteen conversations. Below that a demo can die midway.
    if (left <= 0) stop('OpenRouter balance is EXHAUSTED', `${shown} — paid tiers will 402`);
    else if (left < 1) warn('OpenRouter balance is very low', `${shown} — roughly 15 conversations`);
    else if (left < 5) warn('OpenRouter balance is low', shown);
    else ok('OpenRouter balance healthy', shown);
  } catch (e) {
    warn('OpenRouter balance check failed', String(e.message || e).slice(0, 60));
  }
}

/**
 * Ask each tier ON ITS OWN, so a dead tier is visible BEFORE it is needed.
 *
 * `fallbacks: []` is what makes this honest and must not be dropped. Without
 * it, probing model "atomic-agent" exercises the whole chain: LiteLLM silently
 * fails over and returns 200, so this table reported
 *
 *   [ OK ]  tier 1  openrouter paid  — answers
 *
 * with the balance at -$0.20 and tier 1 returning 402 on every real call. The
 * free tier was quietly carrying the demo. A failover report that cannot tell
 * a working tier from a working fallback measures nothing.
 */
async function callLiteLLM(model, { allowFallbacks = false } = {}) {
  const body = {
    model,
    messages: [{ role: 'user', content: 'Reply with: OK' }],
    // max_tokens matches what an agent turn actually requests. A tiny probe
    // passes on a nearly-empty balance — the real 402 reads "you requested
    // up to 8192 tokens, but can only afford 106" — so a 5-token check
    // would report GO while production traffic fails. Test what ships.
    max_tokens: 8192,
  };
  if (!allowFallbacks) body.fallbacks = [];
  try {
    const r = await fetch(`${LITELLM}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify(body),
    });
    const b = await r.json().catch(() => ({}));
    const good = r.ok && Boolean(b.choices?.length);
    return {
      good,
      servedBy: b.model || '',
      status: good ? 'answers' : (b.error?.message || `HTTP ${r.status}`).slice(0, 58),
    };
  } catch (e) {
    return { good: false, servedBy: '', status: String(e.message || e).slice(0, 58) };
  }
}

async function checkTiers() {
  const tiers = [
    ['atomic-agent', 'tier 1  openrouter paid'],
    ['atomic-agent-fallback', 'tier 2  openrouter paid'],
    ['atomic-agent-deepseek', 'tier 3  openrouter free'],
    ['atomic-agent-direct', 'tier 4  deepseek direct'],
    ['atomic-agent-groq', 'tier 5  groq direct'],
  ];
  // Alias -> underlying model, straight from the running proxy. Needed because
  // the two probes speak different dialects: with `fallbacks: []` LiteLLM
  // echoes the ALIAS ("atomic-agent-deepseek"), and on the chain it returns the
  // UNDERLYING id ("nvidia/nemotron-3-ultra-550b-a55b:free"). Comparing one to
  // the other never matches, and reading the mapping from the proxy keeps this
  // correct when config.yaml changes.
  const underlying = new Map();
  try {
    const r = await fetch(`${LITELLM}/model/info`, { headers: { Authorization: `Bearer ${LLM_KEY}` } });
    const b = await r.json().catch(() => ({}));
    for (const m of b.data || []) {
      // Provider prefix is present in config and absent in responses.
      underlying.set(m.model_name, String(m.litellm_params?.model || '').replace(/^openrouter\//, ''));
    }
  } catch { /* the chain check degrades to "could not name the tier" */ }

  let alive = 0;
  const tierAlive = new Map();
  for (const [model, label] of tiers) {
    const { good, status } = await callLiteLLM(model);

    // No individual tier is a blocker — that is the entire point of having
    // five. What blocks is the CHAIN failing, checked below.
    tierAlive.set(model, good);
    if (good) { alive++; ok(label, status); }
    else if (/api_key|API key|not set|Missing/i.test(status)) console.log(`  [ -- ]  ${label}  — not configured (optional)`);
    else warn(`${label} unavailable`, status);
  }
  if (alive === 0) warn('no individual tier answered', 'the chain check below decides GO/NO-GO');
  else if (alive === 1) warn('only ONE LLM tier is answering', 'no protection if it fails mid-demo');
  else ok(`${alive} LLM tiers answering`, 'failover has somewhere to go');

  // The question a customer's message actually asks: does the router, with
  // failover allowed, produce an answer — and which model paid for it?
  const chain = await callLiteLLM('atomic-agent', { allowFallbacks: true });
  if (!chain.good) {
    stop('the LLM chain does not answer', `${chain.status} — the agent cannot reply at all`);
  } else {
    const [primaryAlias, primaryLabel] = tiers[0];

    // Tiers 1 and 4 are BOTH deepseek-chat — one through OpenRouter, one
    // direct — so the served model id alone cannot tell them apart, and any
    // substring test on "deepseek" would report a fallback as the primary.
    // The isolated probe settles it: if tier 1 did not answer on its own, the
    // chain is on a fallback by definition, whatever it is serving.
    const onPrimary = tierAlive.get(primaryAlias) === true
      && chain.servedBy === underlying.get(primaryAlias);

    if (onPrimary) {
      ok('chain answers on the primary tier', chain.servedBy);
    } else {
      const name = [...underlying.entries()]
        .filter(([alias]) => tierAlive.get(alias))
        .find(([, id]) => id === chain.servedBy)?.[0];
      warn('chain answers only via FALLBACK',
        `${name || chain.servedBy} is carrying traffic, not ${primaryLabel.trim()}`);
    }
  }
  return alive;
}

/** Independence matters more than count: 5 tiers on one account is still 1. */
function checkRails() {
  const rails = [];
  if (process.env.OPENROUTER_API_KEY) rails.push('OpenRouter');
  if (process.env.DEEPSEEK_API_KEY) rails.push('DeepSeek');
  if (process.env.GROQ_API_KEY) rails.push('Groq');
  if (rails.length === 0) stop('no LLM provider key configured at all');
  else if (rails.length === 1) {
    warn(`only ONE payment rail: ${rails[0]}`,
      'an empty balance takes every tier down at once — add DEEPSEEK_API_KEY or GROQ_API_KEY');
  } else ok(`${rails.length} independent payment rails`, rails.join(' + '));
}

async function checkServices() {
  const checks = [
    ['dashboard', `${BASE}/`, true],
    ['litellm', `${LITELLM}/health/liveliness`, true],
    ['temporal UI', 'http://127.0.0.1:8080/', false],
  ];
  for (const [name, url, required] of checks) {
    const s = await httpOk(url);
    if (s && s !== 0) ok(name, `HTTP ${s}`);
    else if (required) stop(`${name} is not responding`, url);
    else warn(`${name} not responding`, url);
  }
}

async function checkDatabase() {
  const db = new Client({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_RESOLVER_USER || 'darex',
    password: process.env.DB_RESOLVER_PASSWORD || 'darex_dev_secret',
    database: process.env.DB_NAME || 'darex',
  });
  try {
    await db.connect();
    // Table is `_migrations`, created by infra/db/migrate.js.
    const applied = await db.query('SELECT COUNT(*)::int AS n FROM _migrations');
    const onDisk = fs.readdirSync(path.join(__dirname, '../db/migrations')).filter((f) => f.endsWith('.sql')).length;
    applied.rows[0].n >= onDisk
      ? ok('migrations applied', `${applied.rows[0].n} of ${onDisk}`)
      : stop('migrations are BEHIND', `${applied.rows[0].n} applied, ${onDisk} on disk — run node infra/db/migrate.js`);

    // An empty knowledge base is the single most common reason a demo looks
    // bad: the agent is working perfectly and has nothing to answer from.
    const km = await db.query('SELECT COUNT(*)::int AS n FROM org_memory');
    km.rows[0].n > 0
      ? ok('knowledge base has content', `${km.rows[0].n} documents across all orgs`)
      : warn('knowledge base is EMPTY', 'the agent will correctly say it does not know — upload a document first');

    // Vector coverage, measured rather than assumed. EMBEDDING_MODEL can be
    // set and embeddings can still be missing — a key added after ingest
    // leaves every existing row unembedded until it is backfilled.
    if (km.rows[0].n > 0) {
      const vec = await db.query('SELECT COUNT(embedding)::int AS n FROM org_memory');
      const pct = Math.round((vec.rows[0].n / km.rows[0].n) * 100);
      if (vec.rows[0].n === 0) {
        console.log(`  [ -- ]  no document embeddings  — keyword search only (${km.rows[0].n} documents)`);
      } else if (pct < 90) {
        warn('document embeddings are INCOMPLETE', `${pct}% embedded — the rest is keyword-only`);
      } else {
        ok('documents embedded', `${pct}%`);
      }
    }
    await db.end();
  } catch (e) {
    stop('database unreachable', String(e.message || e).slice(0, 70));
    // Do NOT call db.end() on a connection that never opened: on Windows that
    // races libuv's handle teardown and aborts the process with an assertion,
    // which would hide the report this script exists to print.
    try { db.removeAllListeners(); } catch { /* nothing to detach */ }
  }
}

(async () => {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  DAREX PREFLIGHT — is this safe to demo right now?           ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('CONFIGURATION');
  checkConfig();
  console.log('\nSERVICES');
  await checkServices();
  console.log('\nDATABASE');
  await checkDatabase();
  console.log('\nRETRIEVAL');
  checkEmbeddings();
  console.log('\nLLM BUDGET');
  await checkCredit();
  console.log('\nPROVIDER INDEPENDENCE');
  checkRails();
  console.log('\nLLM TIERS');
  await checkTiers();

  console.log('\n' + '─'.repeat(64));
  if (blockers.length) {
    console.log(`\n  NO-GO — ${blockers.length} blocker(s):\n`);
    for (const b of blockers) console.log(`    • ${b}`);
    console.log('\n  Do not demo until these are cleared.\n');
    process.exit(1);
  }
  if (warnings.length) {
    console.log(`\n  GO, with ${warnings.length} warning(s):\n`);
    for (const w of warnings) console.log(`    • ${w}`);
    console.log('');
  } else {
    console.log('\n  GO — everything healthy.\n');
  }
  process.exit(0);
})();
