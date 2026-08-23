#!/usr/bin/env node
/**
 * LATENCY PROBE — where does the time actually go?
 *
 * The quality run showed p50 20.2s / p95 78.1s against targets of 15s / 30s.
 * Two competing explanations, and guessing between them is worthless:
 *
 *   (a) the free-tier fallback models are slow / rate-limited, or
 *   (b) the new gate ordering (sanitiser, channel formatter, parent-side
 *       persist) added synchronous latency to the reply path.
 *
 * This measures each layer separately so the question is settled by numbers.
 *
 *   LAYER 1  raw LLM   — N calls straight to LiteLLM, recording the model that
 *                        actually served each one and any retry/fallback.
 *   LAYER 2  gates     — the added synchronous work, timed directly.
 *   LAYER 3  full chain— reported from the quality state file for comparison.
 *
 * Usage: node infra/scripts/latency-probe.js [runs]
 */
const path = require('path');
const fs = require('fs');

// Load infra/.env before anything reads process.env — without this the script
// runs with no provider credentials and then blames the system for it.
require('./lib/env').loadRepoEnv();

const LITELLM = process.env.LITELLM_URL || 'http://127.0.0.1:4000';
const KEY = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || 'sk-darex-local-dev';
const MODEL = process.env.LITELLM_MODEL || 'atomic-agent';
const RUNS = parseInt(process.argv[2] || process.env.LATENCY_RUNS || '10', 10);

/** Ten short, independent prompts — nothing that invites a long answer. */
const PROMPTS = [
  'Reply with exactly: OK',
  'What is 2 + 2? Answer with the number only.',
  'Say hello in one word.',
  'Name one colour.',
  'Reply with exactly: READY',
  'What is the capital of France? One word.',
  'Say yes or no: is water wet?',
  'Count to three, digits only.',
  'Name one day of the week.',
  'Reply with exactly: DONE',
  'What is 10 divided by 2? Number only.',
  'Say goodbye in one word.',
];

const pct = (arr, q) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

async function probeLLM() {
  console.log(`\n===== LAYER 1: raw LLM (${RUNS} calls to ${LITELLM}) =====\n`);
  console.log('  #   ms      model served                         retries  ok');
  console.log('  ' + '-'.repeat(78));

  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    const prompt = PROMPTS[i % PROMPTS.length];
    const t0 = Date.now();
    let served = '(none)';
    let ok = false;
    let attempts = 0;
    let err = '';
    try {
      const res = await fetch(`${LITELLM}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 16,
        }),
      });
      const ms = Date.now() - t0;
      const body = await res.json().catch(() => ({}));
      // LiteLLM reports the model that actually answered, which is how a
      // silent fallback to a slower free tier becomes visible.
      served = body.model || res.headers.get('x-litellm-model-id') || '(unknown)';
      attempts = parseInt(res.headers.get('x-litellm-attempted-retries') || '0', 10);
      ok = res.ok && Boolean(body.choices?.length);
      if (!ok) err = body.error?.message || `HTTP ${res.status}`;
      rows.push({ i: i + 1, ms, served, attempts, ok, err });
    } catch (e) {
      rows.push({ i: i + 1, ms: Date.now() - t0, served, attempts, ok: false, err: String(e.message || e) });
    }
    const r = rows[rows.length - 1];
    console.log(
      `  ${String(r.i).padEnd(3)} ${String(r.ms).padEnd(7)} ${String(r.served).slice(0, 36).padEnd(36)} ${String(r.attempts).padEnd(8)} ${r.ok ? 'yes' : 'NO  ' + r.err.slice(0, 30)}`
    );
  }

  const good = rows.filter((r) => r.ok).map((r) => r.ms);
  console.log('\n  LLM p50 %ss   p95 %ss   min %ss   max %ss   failures %s/%s',
    (pct(good, 0.5) / 1000).toFixed(1), (pct(good, 0.95) / 1000).toFixed(1),
    (Math.min(...good) / 1000).toFixed(1), (Math.max(...good) / 1000).toFixed(1),
    rows.length - good.length, rows.length);

  const byModel = {};
  for (const r of rows) {
    byModel[r.served] = byModel[r.served] || { n: 0, ms: [] };
    byModel[r.served].n++;
    if (r.ok) byModel[r.served].ms.push(r.ms);
  }
  console.log('\n  --- per model served ---');
  for (const [m, v] of Object.entries(byModel)) {
    console.log(`  ${m.padEnd(40)} n=${String(v.n).padEnd(4)} p50=${(pct(v.ms, 0.5) / 1000).toFixed(1)}s`);
  }
  return { rows, p50: pct(good, 0.5), p95: pct(good, 0.95) };
}

function probeGates() {
  console.log('\n===== LAYER 2: synchronous gate cost =====\n');
  let gate;
  try {
    gate = require(path.join(__dirname, '../../services/workflows/dist/reply-gate.js'));
  } catch (e) {
    console.log('  (skipped — build services/workflows first: ' + e.message + ')');
    return null;
  }
  const sample =
    'I understand you are requesting deletion of your personal data under GDPR. '
    + '**What I can help with:**\n- check connected systems\n- guide the process\n'
    + 'Order #INV-2024-0912 shipped on 2024-09-12 for Rs 1,299.';

  const N = 20000;
  const timed = (label, fn) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) fn();
    const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
    console.log(`  ${label.padEnd(34)} ${us.toFixed(3)} µs/call`);
    return us;
  };

  const a = timed('sanitiseCustomerReply', () => gate.sanitiseCustomerReply(sample));
  const b = timed('formatForChannel (whatsapp)', () => gate.formatForChannel(sample, 'whatsapp'));
  const c = timed('detectThirdPartyPiiRequest', () =>
    gate.detectThirdPartyPiiRequest('What is the phone number of the customer who messaged before me?'));

  const totalMs = (a + b + c) / 1000;
  console.log(`\n  total added CPU per reply: ${totalMs.toFixed(4)} ms`);
  console.log('  (the parent-side saveMessageActivity replaced the child-side one:');
  console.log('   same single INSERT, moved — not an extra round trip)');
  return totalMs;
}

function reportChain() {
  console.log('\n===== LAYER 3: full chain (from the last quality run) =====\n');
  const f = path.join(__dirname, '.harden-state/quality.json');
  if (!fs.existsSync(f)) { console.log('  (no quality state on disk)'); return null; }
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  const rows = Object.values(st.results).filter((r) => r.ms > 0);
  const ms = rows.map((r) => r.ms);
  console.log('  case          ms');
  for (const r of rows.sort((a, b) => b.ms - a.ms)) {
    console.log(`  ${String(r.id).padEnd(13)} ${(r.ms / 1000).toFixed(1)}s`);
  }
  console.log(`\n  chain p50 ${(pct(ms, 0.5) / 1000).toFixed(1)}s   p95 ${(pct(ms, 0.95) / 1000).toFixed(1)}s`);
  return { p50: pct(ms, 0.5), p95: pct(ms, 0.95) };
}

(async () => {
  const llm = await probeLLM();
  const gates = probeGates();
  const chain = reportChain();

  console.log('\n===== VERDICT =====\n');
  if (gates !== null) {
    console.log(`  Gate work adds ${gates.toFixed(4)} ms per reply.`);
  }
  if (chain && llm) {
    // A single agent turn is several LLM calls (plan, tool, answer) plus the
    // critic — so the chain is expected to be a multiple of one raw call.
    const ratio = chain.p50 / Math.max(llm.p50, 1);
    console.log(`  Raw LLM p50 ${(llm.p50 / 1000).toFixed(1)}s vs full chain p50 ${(chain.p50 / 1000).toFixed(1)}s`);
    console.log(`  Chain is ~${ratio.toFixed(1)}x one LLM call (an agent turn makes several).`);
    console.log(`  Attributable to LLM: ~${((llm.p50 * ratio) / 1000).toFixed(1)}s of ${(chain.p50 / 1000).toFixed(1)}s`);
  }
  console.log('');
})();
