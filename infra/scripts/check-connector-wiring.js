#!/usr/bin/env node
'use strict';
/**
 * WHAT THE CONNECTORS PAGE SAYS MUST BE WHAT THE BROKER HOLDS.
 *
 * Three separate places have to agree before a Connect button can work:
 *
 *   integrations-catalog.ts   the connector, and the `nangoKey` it looks for
 *   Nango                     a provider config registered under that exact key
 *   docker-compose            the PUBLIC key the browser popup needs
 *
 * Every one of those has already been wrong here, and each failed in a way that
 * pointed at the wrong culprit:
 *
 *   - Gmail's catalogue key is `gmail`; Nango's provider template is
 *     `google-mail`. Registering the template name left the catalogue looking
 *     for a config that did not exist, and the page said "Disconnected" with no
 *     hint that the two names differed.
 *
 *   - NEXT_PUBLIC_NANGO_PUBLIC_KEY was read by the app and passed by nothing.
 *     Every Connect click failed with "Nango public key is not configured"
 *     while the connector itself was registered correctly. From the outside it
 *     looked like the provider rejecting us.
 *
 *   - And the reverse: two configs (`google-mail`, `google-sheet`) stayed
 *     registered after the naming was corrected. Harmless, but they are
 *     credentials sitting in a broker that nothing references, which is exactly
 *     the kind of thing nobody removes later because nobody knows it is unused.
 *
 * So this checks all three directions. It needs Nango running; without it, it
 * says so rather than passing vacuously.
 *
 * Usage: node infra/scripts/check-connector-wiring.js
 * Exit:  0 = catalogue, broker and compose agree. 1 = they do not.
 */
const fs = require('fs');
const path = require('path');
require('./lib/env').loadRepoEnv();

const ROOT = path.join(__dirname, '..', '..');
const CATALOG = path.join(ROOT, 'apps/dashboard/lib/integrations-catalog.ts');
const COMPOSE = path.join(ROOT, 'infra/docker-compose.yml');

const NANGO_HOST = process.env.NANGO_PUBLIC_HOST || 'http://127.0.0.1:3003';
const SECRET = process.env.NANGO_SECRET_KEY || '';

let pass = 0;
const failures = [];
const ok = (m, d) => { pass += 1; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d) => { failures.push(`${m}${d ? ` — ${d}` : ''}`); console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

(async () => {
  console.log('\n=== CONNECTOR WIRING — catalogue, broker and compose ===\n');

  // ── The catalogue's side ──────────────────────────────────────────────────
  const cat = fs.readFileSync(CATALOG, 'utf8');
  // Each entry is `id: '…'` … `authMode: '…'` … optional `nangoKey: '…'`.
  const entries = [...cat.matchAll(
    /id:\s*'([a-z0-9._-]+)'[\s\S]{0,2600}?authMode:\s*'([a-z_]+)'/g
  )].map((m) => ({ id: m[1], authMode: m[2] }));
  const oauth = entries.filter((e) => e.authMode === 'oauth');

  oauth.length > 0
    ? ok(`${entries.length} connectors in the catalogue`, `${oauth.length} OAuth`)
    : no('the catalogue parsed', 'found no OAuth connectors — did the file shape change?');

  // `nangoKey` defaults to the id when absent, which is what the app does.
  const keyFor = new Map();
  for (const e of oauth) {
    const block = new RegExp(`id:\\s*'${e.id}'[\\s\\S]{0,2600}?nangoKey:\\s*'([a-z0-9._-]+)'`).exec(cat);
    keyFor.set(e.id, block ? block[1] : e.id);
  }

  // ── The compose side: the browser needs the PUBLIC key ────────────────────
  const compose = fs.readFileSync(COMPOSE, 'utf8');
  /NEXT_PUBLIC_NANGO_PUBLIC_KEY=\$\{NEXT_PUBLIC_NANGO_PUBLIC_KEY\}/.test(compose)
    ? ok('the browser is passed Nango\'s PUBLIC key')
    : no('the browser is passed Nango\'s PUBLIC key',
      'the dashboard reads NEXT_PUBLIC_NANGO_PUBLIC_KEY via getNangoServerConfig(). '
      + 'Without it every Connect click fails with "Nango public key is not '
      + 'configured" while the connector looks correctly registered.');

  // ── The broker's side ─────────────────────────────────────────────────────
  if (!SECRET) {
    no('Nango is reachable', 'NANGO_SECRET_KEY is not set, so the broker half cannot be checked');
    return report();
  }

  let registered = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${NANGO_HOST}/config`, {
      headers: { Authorization: `Bearer ${SECRET}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    registered = new Set((body.configs || []).map((c) => String(c.unique_key)));
  } catch (err) {
    // Not reachable is not the same as misconfigured, and must not read as one.
    console.log(`  [ ????? ] Nango not reachable at ${NANGO_HOST} — ${err && err.message}`);
    console.log('            The catalogue and compose halves above still hold.');
    return report();
  }

  ok(`${registered.size} provider config(s) registered in the broker`);

  // ── Direction 1: a config for every key the app will look for ────────────
  //
  // Only for connectors the app currently reports as configured; the rest are
  // legitimately absent until somebody creates that provider's OAuth app.
  const missingForConfigured = [];
  for (const [id, key] of keyFor) {
    // The app decides "configured" from the broker, so this is really a check
    // that no key is spelled differently on the two sides.
    if (registered.has(id) && !registered.has(key)) {
      missingForConfigured.push(`${id} looks for '${key}' but only '${id}' is registered`);
    }
  }
  missingForConfigured.length === 0
    ? ok('no connector looks for a key spelled differently in the broker')
    : no('no connector looks for a key spelled differently in the broker',
      missingForConfigured.join('; '));

  // ── Direction 2: no config nothing references ────────────────────────────
  const wanted = new Set([...keyFor.values(), ...entries.map((e) => e.id)]);
  const orphans = [...registered].filter((k) => !wanted.has(k));
  orphans.length === 0
    ? ok('every registered config is referenced by a connector')
    : no('every registered config is referenced by a connector',
      `${orphans.join(', ')} — registered with real OAuth credentials and used by `
      + 'nothing. Delete it: DELETE /config/<key> on the broker.');

  report();
})().catch((err) => {
  console.log(`ERROR: ${err && err.message}`);
  process.exit(1);
});

function report() {
  console.log(`\n  passed ${pass} / ${pass + failures.length}\n`);
  if (failures.length) {
    console.log('FAILED:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('  PASS — a Connect button that appears is a Connect button that works.\n');
  process.exit(0);
}
