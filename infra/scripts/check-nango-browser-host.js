#!/usr/bin/env node
'use strict';
/**
 * THE OAUTH POPUP MUST OPEN ON AN ADDRESS THE BROWSER CAN RESOLVE.
 *
 * One Nango server, two addresses. The dashboard container reaches it at its
 * compose service name, `http://nango-server:3003`. A browser cannot resolve
 * that name — it exists only inside the Docker network. So every Nango URL that
 * crosses into the browser must be a published address.
 *
 * Before this guard, /api/integrations/nango-token handed the browser
 * `http://nango-server:3003` for both the OAuth popup host and the "register a
 * client id here" link. Nothing failed loudly. `oauthConfigured:false` was
 * correct and honest, so the visible symptom was only that the setup
 * instruction named a host the user could not open. The moment a real client id
 * existed, `nango.auth()` would have dialled the same unresolvable host and
 * opened a blank popup, with nothing in any log to say why.
 *
 * That is why this is checked and not merely fixed: the failure is silent, and
 * it only becomes visible at the moment someone first tries to connect for real.
 *
 * Tests the SHIPPED function, extracted from its own source file, so this
 * cannot pass against a copy of the logic that has drifted from the original.
 *
 * Usage: node infra/scripts/check-nango-browser-host.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CATALOG = path.join(ROOT, 'apps/dashboard/lib/integrations-catalog.ts');
const ROUTE = path.join(ROOT, 'apps/dashboard/app/api/integrations/nango-token/route.ts');
const COMPOSE = path.join(ROOT, 'infra/docker-compose.yml');

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  NANGO — the URL handed to the browser must be browser-reachable     ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

const catalog = fs.readFileSync(CATALOG, 'utf8');
const route = fs.readFileSync(ROUTE, 'utf8');
const compose = fs.readFileSync(COMPOSE, 'utf8');

// ── Load the real function out of the real file ─────────────────────────────
// Its body is already valid JS; only the signature carries type annotations.
let browserReachableOrigin;
{
  const m = catalog.match(/export function browserReachableOrigin\([\s\S]*?\n\}/);
  if (!m) {
    no('browserReachableOrigin exists in integrations-catalog.ts');
    console.log('\n  Cannot test behaviour without the function. Stopping.\n');
    process.exit(1);
  }
  const js = m[0]
    .replace(/^export /, '')
    .replace(/\(raw:\s*string\):\s*string/, '(raw)');
  browserReachableOrigin = new Function(`${js}; return browserReachableOrigin;`)();
  ok('browserReachableOrigin loaded from its own source', 'behaviour tested, not a re-implementation');
}

// ── Behaviour ───────────────────────────────────────────────────────────────
const cases = [
  // the actual bug: a compose service name reaching the browser
  ['http://nango-server:3003', 'http://127.0.0.1:3003', 'compose service name is rewritten to loopback, port kept'],
  // things that must NOT be touched
  ['http://localhost:3003', 'http://localhost:3003', 'localhost is already reachable and left alone'],
  ['http://127.0.0.1:3003', 'http://127.0.0.1:3003', 'loopback is left alone'],
  ['https://app.example.com', 'https://app.example.com', 'a real public origin is left alone'],
  ['https://nango.darex.in:8443', 'https://nango.darex.in:8443', 'a public host keeps its scheme and port'],
];
for (const [input, expected, why] of cases) {
  const got = browserReachableOrigin(input);
  got === expected ? ok(why, `${input} -> ${got}`) : no(why, `${input} -> ${got}, expected ${expected}`);
}

// A malformed value must not throw and take the whole route down with it.
try {
  const got = browserReachableOrigin('not a url at all');
  ok('a malformed origin is returned unchanged rather than thrown', `-> ${got}`);
} catch (e) {
  no('a malformed origin is returned unchanged rather than thrown', e.message);
}

// ── The guard is actually applied at both browser-facing sites ──────────────
const uiUrlFn = catalog.match(/export function nangoUiUrl\([\s\S]*?\n\}/);
uiUrlFn && /browserReachableOrigin\(/.test(uiUrlFn[0])
  ? ok('nangoUiUrl() passes through the guard', 'the setup link and the reason string both use it')
  : no('nangoUiUrl() passes through the guard', 'a raw env value would reach the browser');

/const nangoHost = browserReachableOrigin\(/.test(route)
  ? ok('the OAuth popup host passes through the guard', 'nango.auth() dials this value')
  : no('the OAuth popup host passes through the guard', 'route.ts hands the raw host to the browser');

// ── The env path is wired too, so the guard is a net and not the mechanism ──
{
  // Only the dashboard serves a browser. worker and atomic-bridge talk to Nango
  // server-to-server and must keep the internal name.
  const dashboard = compose.match(/\n {2}dashboard:\n([\s\S]*?)(?=\n {2}[a-z0-9_-]+:\n|$)/);
  const block = dashboard ? dashboard[1] : '';
  /NEXT_PUBLIC_NANGO_HOST=/.test(block)
    ? ok('the dashboard service declares NEXT_PUBLIC_NANGO_HOST', 'the documented mechanism, not just the fallback')
    : no('the dashboard service declares NEXT_PUBLIC_NANGO_HOST');

  /NANGO_HOST=http:\/\/nango-server:3003/.test(block)
    ? ok('the dashboard keeps the internal NANGO_HOST for its own calls', 'server-to-server is unaffected')
    : no('the dashboard keeps the internal NANGO_HOST for its own calls');
}

console.log(`\n  passed ${pass} / ${pass + fail}\n`);
process.exit(fail ? 1 : 0);
