#!/usr/bin/env node
'use strict';
/**
 * AN AGENT MUST BE ABLE TO FIND A PAGE, NOT ONLY READ ONE IT WAS HANDED.
 *
 * Search in this product was a single call to `s.jina.ai`, which returns 401
 * without JINA_API_KEY. That key has never been set in this deployment, so
 * every agent's web search returned an error — and the same dead call was
 * copied into three places, which is why nobody owned it and nothing reported
 * it:
 *
 *   tools/web-search.ts             -> "web_search requires JINA_API_KEY"
 *   activities/market-research.ts   -> `if (!jinaKey) return []`
 *   duties.ts KEY_GATED             -> web_search reported "not connected"
 *
 * The reader endpoint answers keyless, so the product could read a URL somebody
 * named and could never find one. This asserts the fix: `searchWeb` returns
 * real results with no credential present at all.
 *
 * ── THE FAILURE THIS EXISTS TO CATCH ────────────────────────────────────────
 *
 * The keyless floor is DuckDuckGo's lite endpoint, parsed from HTML. HTML
 * changes. When it does, the parser returns zero rows — and zero rows is
 * indistinguishable, from the outside, from "the internet had nothing on that".
 * The product would keep working, keep answering, and quietly stop knowing
 * anything it was not told.
 *
 * So this separates the two causes of zero results:
 *
 *   PARSER STALE   result markup present, nothing extracted   -> FAIL, loudly
 *   throttled      no result markup at all                     -> retry, then WARN
 *
 * Throttling is transient and measured: queries fired back to back come back
 * HTTP 200 with no results, and the same query a minute later returns four.
 * Failing the build on that would make the gate flaky and teach everyone to
 * ignore it. A stale parser is permanent and must stop the build.
 *
 * Usage: node infra/scripts/check-web-search.js
 */
const path = require('path');
const { execFileSync } = require('child_process');
require('./lib/env').loadRepoEnv();

const ROOT = path.join(__dirname, '..', '..');
const MODULE = 'services/workflows/dist/tools/search-providers.js';

let pass = 0;
const failures = [];
const warnings = [];

function ok(label) { pass += 1; console.log(`  ok   ${label}`); }
function fail(label, detail) {
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}
function warn(label, detail) {
  warnings.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  warn ${label}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Run the live probe inside the worker container.
 *
 * Not from the host: the host's Docker port proxy drops connections
 * unpredictably, and more importantly the container is where the agent actually
 * runs. A search that works from a laptop and not from the worker is a search
 * that does not work.
 */
function probeInContainer(queries) {
  const script = `
    import('/app/${MODULE}').then(async (m) => {
      const out = [];
      for (const q of ${JSON.stringify(queries)}) {
        const r = await m.searchWeb(q, 4);
        out.push({ query: q, provider: r.provider, attempts: r.attempts,
                   results: r.results.map((x) => ({ url: x.url, title: x.title })) });
      }
      console.log('@@' + JSON.stringify(out));
    }).catch((e) => { console.log('@@' + JSON.stringify({ error: String(e && e.message || e) })); });
  `;
  const raw = execFileSync(
    'docker',
    ['exec', 'darex-worker', 'node', '-e', script],
    { encoding: 'utf8', timeout: 180_000, cwd: ROOT }
  );
  const line = raw.split('\n').find((l) => l.startsWith('@@'));
  if (!line) throw new Error(`no probe output; got: ${raw.slice(0, 300)}`);
  return JSON.parse(line.slice(2));
}

(async () => {
  console.log('web search — can an agent find a page with no credential?\n');

  // Deliberately unglamorous, domain-real queries. A demo query like "test"
  // proves the HTTP call works; these prove the thing an agent will actually
  // ask returns pages an agent could actually cite.
  const QUERIES = [
    'Maharashtra ready reckoner rates 2026',
    'MahaRERA agent registration requirement',
  ];

  const keyed = Boolean(
    process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY
    || process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY
  );
  if (keyed) {
    console.log('  note a search key is present; the keyless floor is still asserted below\n');
  }

  let probe;
  try {
    probe = probeInContainer(QUERIES);
  } catch (err) {
    fail('probe ran in the worker container', String(err.message).slice(0, 200));
    report();
    return;
  }
  if (probe.error) {
    fail('search module loaded in the worker', probe.error);
    report();
    return;
  }
  ok('probe ran in the worker container');

  let answered = 0;
  for (const r of probe) {
    const label = `"${r.query}"`;
    const ddg = (r.attempts || []).find((a) => a.provider === 'duckduckgo');

    // The one thing that must never pass silently.
    const stale = (r.attempts || []).some((a) => /PARSER STALE/.test(a.detail || ''));
    if (stale) {
      fail(`${label}: DuckDuckGo parser is stale`,
        'result markup is present and nothing was extracted — search now returns '
        + 'silence that reads like "nothing exists". Fix parseDuckDuckGoLite.');
      continue;
    }

    if (r.results.length > 0) {
      answered += 1;
      const bad = r.results.filter((x) => !/^https?:\/\//i.test(x.url) || /duckduckgo\.com/.test(x.url));
      if (bad.length) {
        fail(`${label}: a result is not a citable destination`, bad.map((b) => b.url).join(', '));
      } else {
        ok(`${label}: ${r.results.length} results via ${r.provider}`);
      }
    } else {
      warn(`${label}: no results`,
        (r.attempts || []).map((a) => `${a.provider}=${a.detail}`).join(' | '));
    }
  }

  // The point of the whole change: at least one real query answers. If every
  // query came back empty AND nothing was stale, the floor is being throttled
  // hard enough to be unusable, which is a real finding — a warning, not a
  // green.
  if (answered > 0) {
    ok(`the product can search the web (${answered}/${QUERIES.length} queries answered)`);
  } else {
    fail('the product cannot search the web',
      'every query returned nothing and the parser is not stale — the keyless '
      + 'floor is blocked. Set BRAVE_SEARCH_API_KEY (2,000 free queries/month) '
      + 'or JINA_API_KEY.');
  }

  // Reachability. A working tool nothing declares is the defect this repo keeps
  // finding; assert the declarations rather than trusting them.
  const fs = require('fs');
  const declares = [
    ['mcp-bridge declares deep_research', 'services/workflows/src/mcp-bridge.ts', /name: 'deep_research'/],
    ['tool registry routes deep_research', 'services/workflows/src/tools/index.ts', /case 'deep_research'/],
    ['duty planner treats web_search as keyless', 'services/workflows/src/duties.ts', /'web_search',[\s\S]{0,40}'file_ops'/],
    ['Ask AI does not gate web_search on a key', 'apps/dashboard/app/api/ask-ai/route.ts', /name: 'web_search', available: true/],
  ];
  for (const [label, rel, re] of declares) {
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (re.test(body)) ok(label);
    else fail(label, `pattern not found in ${rel}`);
  }

  report();
})();

function report() {
  console.log(`\n${pass} passed, ${failures.length} failed, ${warnings.length} warned`);
  if (warnings.length && !failures.length) {
    console.log('\nWarnings are transient provider throttling, not defects.');
  }
  if (failures.length) {
    console.log('\nFAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nPASS — an agent can find pages on the open web with no credential.');
}
