/**
 * Who is this, across every channel.
 *
 * The tests are weighted the way the risk is. Under-merging costs context and
 * makes the agent look forgetful. Over-merging shows one customer another
 * customer's budget, address and complaints — a privacy breach with a person's
 * name on it, which cannot be undone.
 *
 * So the "must NOT merge" cases outnumber the "must merge" ones, and every
 * ambiguous input is asserted to stay separate.
 *
 * Run: node --test dist/identity/identity.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  normalisePhone, normaliseEmail, normaliseIdentity, isSamePerson, groupIntoPeople,
} from './identity';

// ── One person, five spellings ──────────────────────────────────────────────

test('THE POINT: one Indian mobile written five ways is one person', () => {
  const spellings = [
    '+919799992973',
    '919799992973',
    '09799992973',
    '9799992973',
    '+91 97999 92973',
  ];
  const canonical = spellings.map((s) => normalisePhone(s));
  for (const c of canonical) {
    assert.equal(c.confident, true, `could not place ${c.raw}`);
    assert.equal(c.value, '919799992973', `${c.raw} normalised to ${c.value}`);
  }
  // And pairwise, which is how it is actually used.
  for (const a of spellings) {
    for (const b of spellings) assert.equal(isSamePerson(a, b), true, `${a} vs ${b}`);
  }
});

test('punctuation and spacing never make a new person', () => {
  assert.equal(isSamePerson('(+91)-97999-92973', '+919799992973'), true);
  assert.equal(isSamePerson('+91 9799 992 973', '9799992973'), true);
  assert.equal(isSamePerson('0091 9799992973', '+919799992973'), true, '00 is the other +');
});

test('email case never makes a new person', () => {
  assert.equal(isSamePerson('Raj@Example.COM', 'raj@example.com'), true);
  assert.equal(normaliseEmail('  RAJ@Example.com ').value, 'raj@example.com');
});

// ── Must NEVER merge ────────────────────────────────────────────────────────

test('PRIVACY: two different numbers are two different people', () => {
  assert.equal(isSamePerson('9799992973', '9799992974'), false, 'one digit apart');
  assert.equal(isSamePerson('+919799992973', '+919799992937'), false, 'transposed');
});

test('PRIVACY: a phone and an email are never the same person', () => {
  assert.equal(isSamePerson('9799992973', 'raj@example.com'), false);
});

test('PRIVACY: two different emails are two people, however similar', () => {
  assert.equal(isSamePerson('raj@example.com', 'raj@example.co'), false);
  assert.equal(isSamePerson('raj@example.com', 'raj2@example.com'), false);
});

test('PRIVACY: gmail dots and +tags are NOT merged', () => {
  // They do reach one inbox at Gmail. They do not everywhere, and one wrong
  // provider guess joins two strangers. Under-merge on purpose.
  assert.equal(isSamePerson('r.a.j@gmail.com', 'raj@gmail.com'), false);
  assert.equal(isSamePerson('raj+flats@gmail.com', 'raj@gmail.com'), false);
});

test('PRIVACY: a shortcode is not a person and never merges', () => {
  const a = normalisePhone('56767');
  assert.equal(a.confident, false, 'a 5-digit shortcode cannot be placed');
  assert.equal(isSamePerson('56767', '56767'), false,
    'even two identical unplaceable handles must not be declared the same person');
});

test('PRIVACY: an unparseable handle only ever matches nothing', () => {
  for (const junk of ['', '   ', 'unknown', '+', '12']) {
    assert.equal(isSamePerson(junk, junk), false, `merged on junk: "${junk}"`);
  }
});

test('a landline without a country code is not confidently placed', () => {
  // 022 is Mumbai; the pattern is not a mobile and cannot be canonicalised
  // safely against a bare-10-digit rule.
  assert.equal(normalisePhone('02226543210').confident, false);
});

test('a foreign number is kept whole rather than guessed at', () => {
  const uk = normalisePhone('+442071838750');
  assert.equal(uk.confident, true);
  assert.equal(uk.value, '442071838750', 'kept as dialled, not re-homed to +91');
  assert.equal(isSamePerson('+442071838750', '2071838750'), false,
    'a bare UK national number must NOT be assumed Indian');
});

test('SAFETY: a 10-digit number that cannot be an Indian mobile is not assumed to be one', () => {
  // Indian mobiles start 6-9. A number starting 1-5 is something else.
  assert.equal(normalisePhone('1234567890').confident, false);
});

// ── Channel hints ───────────────────────────────────────────────────────────

test('the handle decides, not the channel it arrived on', () => {
  // A WhatsApp row whose handle is an email is an email.
  const viaWhatsApp = normaliseIdentity('Raj@Example.com', 'whatsapp');
  assert.equal(viaWhatsApp.kind, 'email');
  assert.equal(viaWhatsApp.value, 'raj@example.com');
});

test('a username is lower-cased and otherwise untouched', () => {
  const n = normaliseIdentity('RajBuilder', 'slack');
  assert.equal(n.kind, 'handle');
  assert.equal(n.value, 'rajbuilder');
  assert.equal(isSamePerson('RajBuilder', 'rajbuilder', 'slack'), true);
  assert.equal(isSamePerson('RajBuilder', 'RajBuilders', 'slack'), false);
});

// ── Grouping ────────────────────────────────────────────────────────────────

test('grouping collapses spellings and keeps every one of them', () => {
  const people = groupIntoPeople([
    '+919799992973', '09799992973', '9799992973',   // one person, three ways
    '+919812345678',                                 // another
    'raj@example.com', 'RAJ@example.com',            // a third, two ways
  ]);
  assert.equal(people.length, 3, `expected 3 people, got ${people.length}`);
  const biggest = people.find((p) => p.raws.length === 3);
  assert.ok(biggest, 'the three spellings did not collapse');
  assert.equal(biggest.value, '919799992973');
});

test('every unplaceable handle stays its own person', () => {
  const people = groupIntoPeople(['56767', '56767', 'unknown']);
  assert.equal(people.length, 3,
    'two identical shortcodes must NOT be merged — they are not knowably one human');
});

test('a realistic mixed inbox produces the right number of people', () => {
  const people = groupIntoPeople([
    '+919799992973',      // Raj, WhatsApp
    'raj@example.com',    // Raj, email — but NOT knowably the same person,
                          // because nobody told us they are the same human.
    '9812345678',         // Priya
    '+91 98123 45678',    // Priya again, spaced
  ]);
  assert.equal(people.length, 3, 'phone+email are not joined without evidence');
  const priya = people.find((p) => p.value === '919812345678');
  assert.ok(priya && priya.raws.length === 2, 'Priya\'s two spellings did not collapse');
});
