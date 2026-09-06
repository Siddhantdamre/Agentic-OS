#!/usr/bin/env node
/**
 * Accessibility floor for the dashboard.
 *
 * A floor, not a full WCAG audit - it pins the things that were actually
 * broken and would silently come back:
 *
 *   1. A visible keyboard focus ring exists globally. 39 components clear it
 *      with `outline-none`; without the global :focus-visible rule putting it
 *      back, a keyboard user cannot see where they are and the dashboard is
 *      unusable without a mouse.
 *   2. Reduced motion is honoured - vestibular disorders make large
 *      transitions genuinely painful.
 *   3. A skip link exists, so keyboard users are not forced through the whole
 *      sidebar on every page load.
 *   4. Every icon-only button carries an accessible name.
 *
 * Run with --self-test to check the grader itself against known-good and
 * known-bad buttons. It needs that: the naming rule produced TWO false
 * positives before it was right, first flagging `<Icon /> <span>Refresh</span>`
 * and then `{loading ? <Loader2/> : 'Send reset link'}`. A check that fails
 * correct code is worse than no check, because it teaches people to ignore it.
 *
 * Deliberately NOT checked: colour contrast (needs a rendered page) and
 * screen-reader flow (needs a human). Claiming a grep covers those would be
 * the same "reported a failure as a fact" mistake this repo keeps finding.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'apps', 'dashboard');

/** Does this button body contain anything a screen reader would announce? */
function hasAccessibleName(attrs, body) {
  if (/aria-label|aria-labelledby|title=/.test(attrs)) return true;
  // Strip tags first, so className and other prop strings go with them.
  // Whatever letters survive are text a screen reader would announce - bare
  // text, or a string literal, or text inside a JSX expression like
  //   {loading ? (<span>Signing in...</span>) : 'Sign in'}
  // Earlier versions stripped {...} wholesale and flagged both of those as
  // nameless. Deliberately permissive now: {loading && <Icon/>} passes on the
  // identifier alone. A missed icon costs one manual review; a false positive
  // blocks correct code and teaches people to ignore the gate.
  return /[A-Za-z]{2,}/.test(body.replace(/<[^>]*>/g, ' '));
}

const BUTTON_RE = /<button([^>]*?)>([\s\S]*?)<\/button>/g;

if (process.argv.includes('--self-test')) {
  const cases = [
    ['icon + span text',      '<button onClick={x}><Icon /> <span>Refresh Status</span></button>', true],
    ['literal in expression', "<button type='submit'>{loading ? <L/> : 'Send reset link'}</button>", true],
    ['aria-label only',       '<button aria-label="Close dialog"><X /></button>', true],
    ['bare text',             '<button>Save</button>', true],
    ['icon only - BAD',       '<button onClick={close}><XIcon className="w-4" /></button>', false],
    ['icon only in expr BAD', '<button>{<Spinner className="animate-spin" />}</button>', false],
  ];
  let bad = 0;
  for (const [name, src, expected] of cases) {
    BUTTON_RE.lastIndex = 0;
    const m = BUTTON_RE.exec(src);
    const got = m ? hasAccessibleName(m[1], m[2]) : null;
    const ok = got === expected;
    if (!ok) bad++;
    console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${name} - expected ${expected}, got ${got}`);
  }
  console.log('');
  console.log(bad ? `  SELF-TEST: ${bad} failing` : '  SELF-TEST: grader is correct');
  process.exit(bad ? 1 : 0);
}

const fails = [];
const pass = (m) => console.log(`  [PASS] ${m}`);
const fail = (m) => { fails.push(m); console.log(`  [FAIL] ${m}`); };

const css = fs.readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
css.includes(':focus-visible') && css.includes('outline:')
  ? pass('global keyboard focus ring is defined')
  : fail('no global :focus-visible outline - keyboard users cannot see focus');
css.includes('prefers-reduced-motion')
  ? pass('reduced-motion preference is honoured')
  : fail('prefers-reduced-motion is not handled');

const layout = fs.readFileSync(path.join(ROOT, 'app', 'layout.tsx'), 'utf8');
/href="#main"/.test(layout) && /id="main"/.test(layout)
  ? pass('skip-to-content link is wired to a target')
  : fail('skip link missing or points at no target');
/<html[^>]*\slang=/.test(layout)
  ? pass('html element declares a language')
  : fail('html element has no lang attribute');

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx')) out.push(p);
  }
  return out;
};

const nameless = [];
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  BUTTON_RE.lastIndex = 0;
  let m;
  while ((m = BUTTON_RE.exec(src))) {
    if (hasAccessibleName(m[1], m[2])) continue;
    nameless.push(path.relative(ROOT, file) + ':' + src.slice(0, m.index).split('\n').length);
  }
}
nameless.length === 0
  ? pass('no icon-only button is missing an accessible name')
  : fail(`icon-only buttons with no accessible name: ${nameless.slice(0, 5).join(', ')}`);

console.log('');
if (fails.length) { console.log(`  ACCESSIBILITY FLOOR: ${fails.length} failing`); process.exit(1); }
console.log('  ACCESSIBILITY FLOOR: all checks pass');
