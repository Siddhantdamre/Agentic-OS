/**
 * The safety rules are tested first and hardest, because they are the ones that
 * erode quietly. Nobody sets out to let an unattended agent email a customer at
 * 6am; it happens one reasonable-sounding pull request at a time.
 *
 * Run: node --test dist/duties.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  DUTIES,
  dutyForRole,
  toolIsLiveToday,
  planDuty,
  explainBlock,
  marketBriefing,
} from './duties';

const EMPTY_ENV: Record<string, string | undefined> = {};

// ── Rule 1: a duty looks and reports; it never acts ────────────────────────

test('no duty needs a tool that can act on the outside world', () => {
  const ACTING_TOOLS = [
    'gmail', 'whatsapp', 'twilio', 'slack', 'stripe',
    'docusign', 'leegality', 'hubspot', 'salesforce',
  ];
  for (const duty of DUTIES) {
    assert.ok(
      !ACTING_TOOLS.includes(duty.needs.toLowerCase()),
      `duty ${duty.id} needs ${duty.needs}, which can act on the outside world`
    );
  }
});

test('every instruction forbids inventing a value', () => {
  for (const duty of DUTIES) {
    const t = duty.instruction.toLowerCase();
    assert.ok(
      /never invent|never state|do not estimate|never fill|never cite|report only/.test(t),
      `duty ${duty.id} does not forbid inventing a value`
    );
  }
});

test('every instruction makes "nothing to report" an acceptable answer', () => {
  // Without this the model invents a finding to justify the run.
  for (const duty of DUTIES) {
    const t = duty.instruction.toLowerCase();
    assert.ok(
      /if there are none|if both are zero|if nothing|say that it is empty|if a page could not|if the calendar is not|if the payment provider is not/.test(t),
      `duty ${duty.id} gives the agent no way to report nothing`
    );
  }
});

// ── Rule 2: minimum tool, never the employee's full authority ──────────────

test('Sarah holds four tools; her duty runs with one', () => {
  const sarah = {
    id: 'e1',
    name: 'Sarah',
    role: 'Sales / front-of-house',
    toolAllowlist: ['gmail', 'whatsapp', 'hubspot', 'google-calendar', 'database_query'],
  };
  const plan = planDuty(sarah, EMPTY_ENV);
  assert.strictEqual(plan.runnable, true);
  assert.deepStrictEqual(plan.dutyAllowlist, ['database_query']);
  // The thing that must never regress: her duty cannot reach gmail.
  assert.ok(!plan.dutyAllowlist.includes('gmail'));
  assert.ok(!plan.dutyAllowlist.includes('whatsapp'));
});

test('the duty allowlist is never the employee allowlist', () => {
  const wide = {
    id: 'e2',
    name: 'Wide',
    role: 'Ops / analyst',
    toolAllowlist: ['metrics', 'gmail', 'stripe', 'whatsapp'],
  };
  const plan = planDuty(wide, EMPTY_ENV);
  assert.strictEqual(plan.dutyAllowlist.length, 1);
  assert.deepStrictEqual(plan.dutyAllowlist, ['metrics']);
});

// ── Permission and reach are different failures ────────────────────────────

const kabir = {
  id: 'e3',
  name: 'Kabir',
  role: 'Showing coordinator',
  toolAllowlist: ['google-calendar', 'whatsapp', 'gmail'],
};

test('holding a tool that is not connected reports not-connected', () => {
  const plan = planDuty(kabir, EMPTY_ENV, []);
  assert.strictEqual(plan.runnable, false);
  assert.strictEqual(plan.blockedBecause, 'not-connected');
  assert.match(explainBlock(plan), /not connected in this workspace/);
});

test('the same employee becomes runnable once the provider is connected', () => {
  const plan = planDuty(kabir, EMPTY_ENV, ['google-calendar']);
  assert.strictEqual(plan.runnable, true);
  assert.deepStrictEqual(plan.dutyAllowlist, ['google-calendar']);
});

test('not holding the tool reports not-permitted, never not-connected', () => {
  const emma = {
    id: 'e4',
    name: 'Emma',
    role: 'Support / success',
    toolAllowlist: ['gmail', 'whatsapp'], // no database_query
  };
  const plan = planDuty(emma, EMPTY_ENV);
  assert.strictEqual(plan.blockedBecause, 'not-permitted');
  assert.match(explainBlock(plan), /not permitted/);
});

test('an unknown role is a missing duty, not a permission problem', () => {
  const odd = { id: 'e5', name: 'Odd', role: 'Chief Vibes', toolAllowlist: ['metrics'] };
  const plan = planDuty(odd, EMPTY_ENV);
  assert.strictEqual(plan.duty, null);
  assert.strictEqual(plan.blockedBecause, 'no-duty');
});

// ── What is live today ─────────────────────────────────────────────────────

test('the four credential-free tools are always live', () => {
  for (const t of ['database_query', 'metrics', 'web_extract', 'file_ops']) {
    assert.ok(toolIsLiveToday(t, EMPTY_ENV), t);
  }
});

test('web_search is dead without a key and live with one', () => {
  assert.strictEqual(toolIsLiveToday('web_search', EMPTY_ENV), false);
  assert.strictEqual(toolIsLiveToday('web_search', { JINA_API_KEY: 'sk-live' }), true);
});

test('an empty key is not a key', () => {
  assert.strictEqual(toolIsLiveToday('web_search', { JINA_API_KEY: '   ' }), false);
});

test('an OAuth tool is never live from an environment variable alone', () => {
  // The trap this avoids: a workspace-level credential being read as though
  // every tenant had consented.
  assert.strictEqual(
    toolIsLiveToday('gmail', { GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y' }),
    false
  );
  assert.strictEqual(toolIsLiveToday('gmail', EMPTY_ENV, ['gmail']), true);
});

// ── The roster is covered ──────────────────────────────────────────────────

test('every role shipped in the packs has a duty', () => {
  // If a pack ships a role with no duty, that employee joins the workforce and
  // does nothing, which is the exact failure this module exists to end.
  const PACK_ROLES = [
    'Sales / front-of-house',
    'Support / success',
    'Ops / analyst',
    'Buyer ISA',
    'Showing coordinator',
    'Listing coordinator',
  ];
  for (const role of PACK_ROLES) {
    assert.notStrictEqual(dutyForRole(role), null, `no duty defined for pack role "${role}"`);
  }
});

test('duty ids are unique', () => {
  const ids = DUTIES.map((d) => d.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('role lookup ignores case and surrounding space', () => {
  assert.strictEqual(dutyForRole('  ops / ANALYST ')?.id, 'ops.kpi-movement');
});

// ── Market context: business intelligence, not rumour ──────────────────────

test('a fact is never shown to the agent without its source', () => {
  const brief = marketBriefing([
    { fact: 'Thane ready-reckoner rates rose 3.9% in 2026', source: 'igrmaharashtra.gov.in' },
  ]);
  assert.match(brief, /3\.9%/);
  assert.match(brief, /igrmaharashtra\.gov\.in/);
  // The instruction to cite is what stops the model restating it as its own.
  assert.match(brief, /name its source/i);
});

test('a fact with no source is dropped, not shown unsourced', () => {
  const brief = marketBriefing([
    { fact: 'Prices are going up', source: '' },
    { fact: 'Stamp duty is 6% in Thane', source: 'igrmaharashtra.gov.in' },
  ]);
  assert.ok(!/Prices are going up/.test(brief), 'an unsourced claim reached the agent');
  assert.match(brief, /Stamp duty is 6%/);
});

test('the agent is forbidden from inventing market facts', () => {
  const brief = marketBriefing([{ fact: 'x', source: 'y' }]);
  assert.match(brief, /Never state a market fact that is not on this list/i);
});

test('no facts produces no briefing at all, not a placeholder', () => {
  // "market context: none available" makes the agent apologise for it in the
  // answer. Silence makes it answer from what it has.
  assert.strictEqual(marketBriefing([]), '');
  assert.strictEqual(marketBriefing([{ fact: '  ', source: 'x' }]), '');
});

test('every runnable employee receives the same market briefing', () => {
  // Two people in one company reading different facts about the same market is
  // how they reach opposite conclusions and both cite "the data".
  const facts = [{ fact: 'Thane inventory up 12% QoQ', source: 'operator' }];
  const sarah = planDuty(
    { id: '1', name: 'Sarah', role: 'Sales / front-of-house', toolAllowlist: ['database_query'] },
    EMPTY_ENV, [], facts);
  const marcus = planDuty(
    { id: '2', name: 'Marcus', role: 'Ops / analyst', toolAllowlist: ['metrics'] },
    EMPTY_ENV, [], facts);

  assert.ok(sarah.instruction.includes('Thane inventory up 12% QoQ'));
  assert.ok(marcus.instruction.includes('Thane inventory up 12% QoQ'));
  assert.strictEqual(sarah.marketFactCount, 1);
  assert.strictEqual(marcus.marketFactCount, 1);
});

test('the composed instruction still carries the duty itself', () => {
  const p = planDuty(
    { id: '1', name: 'Sarah', role: 'Sales / front-of-house', toolAllowlist: ['database_query'] },
    EMPTY_ENV, [], [{ fact: 'f', source: 's' }]);
  assert.match(p.instruction, /most recent message is from the customer/);
});

test('a blocked employee gets no instruction to run', () => {
  const p = planDuty(
    { id: '1', name: 'Kabir', role: 'Showing coordinator', toolAllowlist: ['google-calendar'] },
    EMPTY_ENV, [], [{ fact: 'f', source: 's' }]);
  assert.strictEqual(p.runnable, false);
  assert.strictEqual(p.instruction, '');
});
