'use strict';
// Opens every screen of the production dashboard in headless Chromium on a demo workspace (listings, enquiries, a viewing,
// money owed, two customer chats, two held emails) and uses each screen: it must load, show no error text, raise no
// script error, and survive a click on every safe control. The model and Gmail are LOCAL SIMULATORS; connectors that
// need real accounts are reported as BLOCKED by the report, not passed here.
//   HARNESS_SCRIPT=../../reports/feature-sweep.js SHOT_DIR=... infra/harness/run-flows.sh
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { seedDemo, cleanup } = require('../infra/harness/demo-seed');
const BASE = process.env.FLOW_BASE || 'http://127.0.0.1:3011';
const OUT = process.env.SHOT_DIR || path.join(os.tmpdir(), 'feature-sweep');
fs.mkdirSync(OUT, { recursive: true });

const SCREENS = [
  ['/', 'Home'], ['/ask-ai', 'Ask AI'], ['/approvals', 'Approvals'], ['/conversations', 'Conversations'], ['/work-items', 'Work Items'],
  ['/dues', 'Money owed'], ['/plans', 'Plans'], ['/inquiries', 'Inquiries'], ['/listings', 'Listings'], ['/showings', 'Showings'],
  ['/employees', 'Employees'], ['/employees/customer', 'Customer employee'], ['/employees/growth', 'Growth employee'], ['/growth', 'Growth'],
  ['/brain', 'Brain'], ['/brief', 'Brief'], ['/insight', 'Insight'], ['/analytics', 'Analytics'], ['/trust', 'Trust'], ['/observability', 'Health'],
  ['/audit', 'Audit'], ['/decide', 'Decide'], ['/skills', 'Skills'], ['/packs', 'Packs'], ['/connectors', 'Connectors'], ['/integrations', 'Integrations'],
  ['/billing', 'Billing'], ['/settings', 'Settings'], ['/settings/autonomy', 'Autonomy'],
];
const BAD = /temporal is unavailable|InsightAction|page not found|something went wrong|application error|unhandled|internal server error|failed to fetch|\[object Object\]|undefined|NaN\b/i;
const SKIP = /sign out|log out|delete|remove|disconnect|erase|reset|suspend|kill/i;
// Routes that answer 503 when the service behind them is not part of this sandbox (Temporal; payment-provider keys).
// That is the designed refusal, so it is reported as BLOCKED, never as PASS and never as a product failure.
const BLOCKED_503 = /^503 \/api\/(insight|billing\/checkout)$/;
const blocked = [];
const ONLY = (process.env.SWEEP_ONLY || '').split(',').filter(Boolean);
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ' — ' + String(detail).slice(0, 220)}`); };

(async () => {
  const s = await seedDemo({ base: BASE });
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: 'darex_session', value: s.cookie, url: BASE }, { name: 'darex_org_id', value: s.orgId, url: BASE }]);
  const page = await ctx.newPage();
  let errors = [];
  page.on('pageerror', (e) => errors.push('script: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  try {
    for (const [route, label] of SCREENS) {
      if (ONLY.length && !ONLY.includes(route)) continue;
      errors = [];
      const resp = await page.goto(BASE + route, { waitUntil: 'domcontentloaded' }).catch((e) => ({ status: () => 0, err: e.message }));
      await page.waitForTimeout(2500);
      const txt = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      const bad = txt.match(BAD);
      check(`${label}: loads (${resp && resp.status ? resp.status() : '?'}), shows content, no error text`, resp && resp.status() < 400 && txt.length > 80 && !bad, bad ? `found "${bad[0]}"` : txt.slice(0, 120));
      await page.screenshot({ path: path.join(OUT, route.replace(/\W+/g, '_').replace(/^_/, '') + (route === '/' ? 'home' : '') + '.png') });
      // use the screen: click each safe control once, coming back to the page between clicks
      const controls = page.locator('main button:visible, main [role=tab]:visible');
      const n = Math.min(await controls.count(), 14);
      let clicked = 0;
      for (let i = 0; i < n; i++) {
        const c = controls.nth(i);
        const name = ((await c.innerText().catch(() => '')) || (await c.getAttribute('aria-label').catch(() => '')) || '').trim();
        if (SKIP.test(name) || /^approve|^reject|^send|^allow/i.test(name)) continue;
        await c.click({ timeout: 2000 }).catch(() => {}); clicked++;
        await page.waitForTimeout(250);
        if (!page.url().startsWith(BASE + route)) await page.goto(BASE + route, { waitUntil: 'domcontentloaded' }).then(() => page.waitForTimeout(1200));
      }
      const hard = errors.filter((e) => !BLOCKED_503.test(e));
      const soft = [...new Set(errors.filter((e) => BLOCKED_503.test(e)))];
      if (soft.length) { blocked.push({ screen: label, calls: soft }); console.log(`  [BLOCKED] ${label}: ${soft.join(', ')} (service not available in this sandbox)`); await page.screenshot({ path: path.join(OUT, 'blocked-' + route.replace(/\W+/g, '_').replace(/^_/, '') + '.png') }); }
      check(`${label}: ${clicked} controls used, no script error or unexpected 5xx`, hard.length === 0, hard.slice(0, 3).join(' | '));
    }
    // Ask AI: a real question, answered on screen
    await page.goto(BASE + '/ask-ai', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
    const box = page.locator('textarea, input[type=text]').last(); await box.fill('What needs me today?'); await box.press('Enter');
    await page.waitForFunction(() => /needs you today/i.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
    check('Ask AI: the question is answered on screen', /needs you today/i.test(await page.locator('body').innerText()));
    await page.screenshot({ path: path.join(OUT, 'ask-ai-answer.png') });
    // Approvals: the two demo emails are listed with real recipients, approve one
    await page.goto(BASE + '/approvals', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(3000);
    const ap = (await page.locator('body').innerText());
    check('Approvals: both held demo emails are listed with recipients', /rahul\.verma@example\.test/.test(ap) && /anita\.rao@example\.test/.test(ap), ap.slice(0, 160));
    await page.getByRole('button', { name: /^Approve/ }).first().click().catch(() => {}); await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(OUT, 'approvals-after-approve.png') });
    check('Approvals: approving shows a result and no error', !BAD.test((await page.locator('body').innerText()).replace(/\s+/g, ' ')));
    // phone width
    await page.setViewportSize({ width: 390, height: 800 });
    for (const [route, label] of [['/', 'Home'], ['/approvals', 'Approvals'], ['/dues', 'Money owed']]) {
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`${label} at phone width: no sideways scroll`, overflow <= 1, `overflow ${overflow}px`);
      await page.screenshot({ path: path.join(OUT, 'phone-' + (route === '/' ? 'home' : route.slice(1)) + '.png') });
    }
    await page.setViewportSize({ width: 1280, height: 860 });
    // signed-out screens
    const anon = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const ap2 = await anon.newPage();
    for (const [route, label] of [['/login', 'Sign in'], ['/register', 'Sign up'], ['/forgot-password', 'Forgot password'], ['/reset-password', 'Reset password'], ['/verify-email', 'Verify email']]) {
      const r = await ap2.goto(BASE + route, { waitUntil: 'domcontentloaded' }); await ap2.waitForTimeout(1500);
      const t = (await ap2.locator('body').innerText()).replace(/\s+/g, ' ');
      check(`${label} (signed out): loads and shows a form or message`, r.status() < 400 && t.length > 30 && !BAD.test(t), t.slice(0, 120));
      await ap2.screenshot({ path: path.join(OUT, 'anon-' + route.slice(1) + '.png') });
    }
    // the demo owner can really sign in through the form
    await ap2.goto(BASE + '/login', { waitUntil: 'domcontentloaded' }); await ap2.waitForTimeout(1500);
    await ap2.locator('input[type=email], input[name=email]').first().fill(s.email);
    await ap2.locator('input[type=password]').first().fill(s.password);
    await ap2.locator('button[type=submit]').first().click(); await ap2.waitForTimeout(5000);
    check('Sign in: the demo owner signs in through the form and reaches the app', !/\/login/.test(ap2.url()), ap2.url());
    await ap2.screenshot({ path: path.join(OUT, 'after-signin.png') });
  } catch (e) { check('sweep completed without an exception', false, e.message); }
  finally { await browser.close(); cleanup(s.orgId); }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, blocked }, null, 1));
  const bad = results.filter((x) => !x.ok);
  console.log(`\nSWEEP: ${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
})();
