'use strict';
// Accessibility scan: opens every static page of the running dashboard in a real browser, signed in as a throwaway
// owner, and runs axe-core (WCAG 2.1 A and AA rules). Exits 1 on any violation, so it can sit in a release check.
//
//   FLOW_BASE=http://127.0.0.1:3011 node a11y-scan.js        (run-flows.sh style environment, see README.md)
//
// Needs a browser driver: `npm i -g playwright` (or set PLAYWRIGHT_MODULE to its path) and a Chromium it can start
// (set CHROMIUM_PATH if it is not the one Playwright downloaded). axe-core is a dev dependency of the dashboard.
const fs = require('fs');
const path = require('path');
const { seed, cleanup } = require('./seed');

const BASE = process.env.FLOW_BASE || 'http://127.0.0.1:3011';
const APP = path.resolve(__dirname, '../../apps/dashboard/app');
const host = new URL(BASE).hostname;
// Pages that need no sign-in. Every other page is opened as the seeded owner.
const PUBLIC = /^\/(login|register|forgot-password|reset-password|verify-email|terms|privacy)$/;

function loadPlaywright() {
  try { return require(process.env.PLAYWRIGHT_MODULE || 'playwright'); } catch (e) {
    console.error('a11y-scan needs Playwright: `npm i -g playwright`, or set PLAYWRIGHT_MODULE to its folder.\n' + e.message);
    process.exit(2);
  }
}
function pages() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'page.tsx') {
        const rel = path.relative(APP, path.dirname(p)).split(path.sep).filter((s) => !/^\(.*\)$/.test(s));
        if (rel.some((s) => s.startsWith('['))) continue; // needs an id in the address
        out.push('/' + rel.join('/'));
      }
    }
  })(APP);
  return [...new Set(out)].sort();
}

(async () => {
  const { chromium } = loadPlaywright();
  const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js', { paths: [path.join(APP, '..')] }), 'utf8');
  const s = seed({ stage: 1, tag: 'a11y' });
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const failures = [];
  let scanned = 0;
  try {
    for (const p of pages()) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      if (!PUBLIC.test(p)) {
        await ctx.addCookies([
          { name: 'darex_session', value: s.cookie, domain: host, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
          { name: 'darex_org_id', value: s.orgId, domain: host, path: '/', secure: false, sameSite: 'Lax' },
        ]);
      }
      const page = await ctx.newPage();
      await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(2500);
      try {
        await page.evaluate(axeSource);
        const res = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }));
        scanned++;
        for (const v of res.violations) for (const n of v.nodes) failures.push(`${p}  ${v.id} (${v.impact})  ${n.html.replace(/\s+/g, ' ').slice(0, 110)}`);
      } catch (e) { failures.push(`${p}  scan failed: ${String(e.message).slice(0, 80)}`); }
      await ctx.close();
    }
  } finally { await browser.close(); cleanup(s.orgId); }
  console.log(`a11y: ${scanned} pages scanned, ${failures.length} failing element(s)`);
  for (const f of failures.slice(0, 60)) console.log('  [FAIL] ' + f);
  console.log(failures.length === 0 ? '==== no accessibility violations ====' : '==== accessibility violations found ====');
  process.exit(failures.length === 0 ? 0 : 1);
})();
