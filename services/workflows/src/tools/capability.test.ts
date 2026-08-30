/**
 * What an AI employee may actually do.
 *
 * The first block is the privilege-escalation defect that shipped, written as
 * a test so it cannot come back. The rest are the cases where getting it wrong
 * means an agent charged a card, signed something, or messaged a customer
 * without anybody agreeing to it.
 *
 * Run: node --test dist/tools/capability.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  isToolGranted, riskOf, needsHuman, decideToolCall, normalizeToolKey, ROLE_HANDS,
} from './capability';

// ── The defect ──────────────────────────────────────────────────────────────

test('ESCALATION: a narrow grant does NOT confer the whole provider', () => {
  // Reproduced against the shipped matcher, which also compared
  // `held.startsWith(want + '-')` and therefore answered TRUE here:
  //   granted ['razorpay-refund-status'] -> may call 'razorpay'
  const grant = ['razorpay-refund-status'];
  assert.equal(isToolGranted('razorpay-refund-status', grant), true, 'the thing granted');
  assert.equal(isToolGranted('razorpay', grant), false,
    'checking a refund status must NOT confer the payments provider');
  assert.equal(isToolGranted('razorpay-payout', grant), false,
    'nor any sibling capability');
});

test('but a BROAD grant does confer everything under it', () => {
  const grant = ['razorpay'];
  assert.equal(isToolGranted('razorpay', grant), true);
  assert.equal(isToolGranted('razorpay-payout', grant), true, 'permission flows downward');
  assert.equal(isToolGranted('razorpay-refund-status', grant), true);
});

test('a grant never leaks sideways to another provider', () => {
  assert.equal(isToolGranted('stripe', ['razorpay']), false);
  assert.equal(isToolGranted('gmail', ['gmail-drafts']), false, 'narrow again');
  // The dash matters: `razorpayX` is not under `razorpay`.
  assert.equal(isToolGranted('razorpayx', ['razorpay']), false,
    'prefix matching must respect the separator, or a lookalike provider inherits');
});

test('underscores and case are the same key', () => {
  assert.equal(normalizeToolKey('Database_Query'), 'database-query');
  assert.equal(isToolGranted('database_query', ['database-query']), true);
  assert.equal(isToolGranted('DATABASE-QUERY', ['database_query']), true);
});

test('an empty allowlist grants nothing', () => {
  assert.equal(isToolGranted('database-query', []), false);
  assert.equal(isToolGranted('', ['database-query']), false);
});

// ── Risk ────────────────────────────────────────────────────────────────────

test('money and signatures are classified as such', () => {
  for (const t of ['razorpay', 'stripe', 'quickbooks']) assert.equal(riskOf(t), 'pay', t);
  for (const t of ['docusign', 'leegality']) assert.equal(riskOf(t), 'sign', t);
});

test('anything that reaches a human is a send', () => {
  for (const t of ['gmail', 'whatsapp', 'twilio', 'slack', 'zendesk']) {
    assert.equal(riskOf(t), 'send', t);
  }
});

test('SAFETY: an unclassified tool is not assumed safe', () => {
  assert.equal(riskOf('some-new-provider'), 'send',
    'an unknown tool must not default to read — that is the one mistake that cannot be undone');
  assert.equal(needsHuman('some-new-provider'), true);
});

test('a named read action downgrades a dangerous provider', () => {
  assert.equal(riskOf('razorpay', 'get_payment'), 'read', 'reading a payment is a read');
  assert.equal(riskOf('razorpay', 'payout'), 'pay', 'but the provider is still pay by default');
  assert.equal(riskOf('razorpay'), 'pay', 'with no action named, assume the worst');
});

test('an UNKNOWN action never downgrades anything', () => {
  assert.equal(riskOf('razorpay', 'settle_everything'), 'pay',
    'guessing safety from an unclassified verb is how a payout goes out unattended');
});

test('a sub-tool inherits from the longest matching provider', () => {
  assert.equal(riskOf('razorpay-payout'), 'pay');
  assert.equal(riskOf('google-calendar-create'), 'draft');
  // 'google-cloud' must win over any shorter 'google-*' entry.
  assert.equal(riskOf('google-cloud-run'), 'delete');
});

test('code execution and the filesystem are not reads', () => {
  assert.equal(riskOf('sandbox'), 'delete');
  assert.equal(riskOf('file-ops'), 'delete');
  assert.equal(needsHuman('sandbox'), true);
});

// ── The whole decision ──────────────────────────────────────────────────────

test('a tool the employee does not hold is refused before risk matters', () => {
  const d = decideToolCall({ tool: 'razorpay', allowlist: ROLE_HANDS.support! });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /does not have razorpay/);
});

test('MONEY ALWAYS ASKS, at every autonomy level', () => {
  for (const level of [0, 1, 2, 3, 99]) {
    const d = decideToolCall({ tool: 'razorpay', allowlist: ['razorpay'], autonomyLevel: level });
    assert.equal(d.allowed, true, 'it is granted');
    assert.equal(d.needsApproval, true, `money stopped asking at autonomy ${level}`);
  }
});

test('so does signing', () => {
  const d = decideToolCall({ tool: 'docusign', allowlist: ['docusign'], autonomyLevel: 99 });
  assert.equal(d.needsApproval, true);
  assert.match(d.reason, /signs something/);
});

test('a read never asks', () => {
  const d = decideToolCall({ tool: 'database-query', allowlist: ROLE_HANDS.support!, autonomyLevel: 0 });
  assert.equal(d.allowed, true);
  assert.equal(d.needsApproval, false);
});

test('reaching a customer is earned, not assumed', () => {
  const untrusted = decideToolCall({ tool: 'whatsapp', allowlist: ['whatsapp'], autonomyLevel: 0 });
  assert.equal(untrusted.needsApproval, true, 'a new employee does not message customers alone');

  const trusted = decideToolCall({ tool: 'whatsapp', allowlist: ['whatsapp'], autonomyLevel: 2 });
  assert.equal(trusted.needsApproval, false, 'a proven one does');
});

test('a missing autonomy level is treated as untrusted', () => {
  const d = decideToolCall({ tool: 'gmail', allowlist: ['gmail'] });
  assert.equal(d.needsApproval, true, 'absent trust is not full trust');
});

// ── The roles actually differ ───────────────────────────────────────────────

test('THE POINT: the roles have different hands', () => {
  const support = ROLE_HANDS.support!;
  const sales = ROLE_HANDS.sales!;
  const collections = ROLE_HANDS.collections!;

  assert.equal(isToolGranted('google-calendar', sales), true, 'sales can book a viewing');
  assert.equal(isToolGranted('google-calendar', support), false, 'support cannot');
  assert.equal(isToolGranted('quickbooks', collections), true, 'collections can see what is owed');
  assert.equal(isToolGranted('quickbooks', support), false, 'support cannot');
  assert.equal(isToolGranted('zendesk', support), true, 'support owns the ticket queue');
  assert.equal(isToolGranted('zendesk', sales), false, 'sales does not');
});

test('NO role is handed money or a signature by default', () => {
  for (const [role, hands] of Object.entries(ROLE_HANDS)) {
    for (const dangerous of ['razorpay', 'stripe', 'docusign', 'leegality']) {
      assert.equal(isToolGranted(dangerous, hands), false,
        `${role} was given ${dangerous} by default — that must be a deliberate, per-employee grant`);
    }
  }
});

test('and no role is handed code execution or the filesystem by default', () => {
  for (const [role, hands] of Object.entries(ROLE_HANDS)) {
    for (const dangerous of ['sandbox', 'file-ops', 'google-cloud']) {
      assert.equal(isToolGranted(dangerous, hands), false, `${role} was given ${dangerous}`);
    }
  }
});

test('every role can still read, or it cannot do its job at all', () => {
  for (const [role, hands] of Object.entries(ROLE_HANDS)) {
    assert.equal(isToolGranted('database-query', hands), true, `${role} cannot read`);
  }
});
