import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isHumanDestination,
  lockToEmployee,
  mergeRoutedForCaller,
  route,
  type RouteEmployee,
} from './route-employee.js';

const ROSTER: RouteEmployee[] = [
  {
    id: 'emp-sarah',
    name: 'Sarah',
    role: 'Sales & Lead Gen',
    persona: 'ISA / sales',
    toolAllowlist: ['gmail', 'whatsapp', 'hubspot'],
    status: 'active',
  },
  {
    id: 'emp-emma',
    name: 'Emma',
    role: 'Customer Support',
    persona: 'Support',
    toolAllowlist: ['gmail', 'whatsapp', 'google-calendar'],
    status: 'active',
  },
  {
    id: 'emp-marcus',
    name: 'Marcus',
    role: 'Marketing & Analytics',
    persona: 'Ops',
    toolAllowlist: ['meta-ads', 'google-ads', 'gmail'],
    status: 'active',
  },
  {
    id: 'emp-research',
    name: 'Research',
    role: 'Research',
    persona: 'Cite web + docs',
    toolAllowlist: ['web_search', 'google-drive', 'notion'],
    status: 'active',
  },
  {
    id: 'emp-finance',
    name: 'Finance',
    role: 'Finance',
    persona: 'Confirm before pay',
    toolAllowlist: ['stripe', 'razorpay'],
    status: 'active',
  },
  {
    id: 'emp-executive',
    name: 'Executive',
    role: 'Executive',
    persona: 'Cross-domain coordinator',
    toolAllowlist: ['web_search', 'database_query', 'cognee', 'daily_brief'],
    status: 'active',
  },
];

test('emergency keyword routes to dispatch/human, not ISA Sarah', () => {
  const result = route({
    orgId: 'org-1',
    userMessage: 'EMERGENCY water leak in unit 4B, burst pipe',
    employees: ROSTER,
  });
  assert.equal(result.destination, 'dispatch');
  assert.equal(isHumanDestination(result.destination), true);
  assert.notEqual(result.employeeName, 'Sarah');
  assert.notEqual(result.rosterKey, 'sales');
  assert.match(result.reason, /emergency/i);
});

test('Ask Marcus to … locks Marcus', () => {
  const result = route({
    orgId: 'org-1',
    userMessage: 'Ask Marcus to pull campaign ROAS for last week',
    employees: ROSTER,
  });
  assert.equal(result.destination, 'employee');
  assert.equal(result.employeeName, 'Marcus');
  assert.equal(result.employeeId, 'emp-marcus');
  assert.equal(result.locked, true);
});

test('greeting stays solo support — never a crew of 3+', () => {
  const result = route({
    orgId: 'org-1',
    userMessage: 'hi',
    employees: ROSTER,
  });
  assert.equal(result.destination, 'employee');
  assert.equal(result.employeeName, 'Emma');
  assert.equal(result.locked, false);
  assert.match(result.reason, /solo/);
});

test('paused Finance is not selected for payment-link asks', () => {
  const roster = ROSTER.map((e) =>
    e.name === 'Finance' ? { ...e, status: 'paused' as const } : e
  );
  const result = route({
    orgId: 'org-1',
    userMessage: 'Create a Razorpay payment link for invoice 1042',
    employees: roster,
  });
  assert.notEqual(result.employeeName, 'Finance');
  assert.notEqual(result.rosterKey, 'finance');
});

test('Customer with Stripe stays support and does not take Finance work', () => {
  const roster: RouteEmployee[] = [
    {
      id: 'emp-customer',
      name: 'Customer',
      role: 'Customer Resolution',
      persona: 'Refunds and order follow-ups',
      toolAllowlist: ['gmail', 'stripe', 'hubspot'],
      status: 'active',
    },
    ...ROSTER,
  ];
  const payment = route({
    orgId: 'org-1',
    userMessage: 'Create a Razorpay payment link for invoice 1042',
    employees: roster,
  });
  assert.equal(payment.employeeName, 'Finance');

  const refund = route({
    orgId: 'org-1',
    userMessage: 'Process a refund for order 88',
    employees: roster,
  });
  assert.equal(refund.employeeName, 'Customer');

  const refundStripe = route({
    orgId: 'org-1',
    userMessage: 'refund this Stripe payment',
    employees: roster,
  });
  assert.equal(refundStripe.employeeName, 'Customer');
  assert.notEqual(refundStripe.employeeName, 'Finance');

  const ads = route({
    orgId: 'org-1',
    userMessage: 'Pull Meta ads ROAS for last week',
    employees: [
      {
        id: 'emp-ops',
        name: 'Operations',
        role: 'Operations',
        persona: 'Reconcile records',
        toolAllowlist: ['google-sheets', 'hubspot'],
        status: 'active',
      },
      ...roster,
    ],
  });
  assert.equal(ads.employeeName, 'Marcus');
});

test('active Finance is selected for payment-link asks', () => {
  const result = route({
    orgId: 'org-1',
    userMessage: 'Create a Razorpay payment link for invoice 1042',
    employees: ROSTER,
  });
  assert.equal(result.employeeName, 'Finance');
  assert.equal(result.rosterKey, 'finance');
});

test('founder questions route to Research (cite tools), not support', () => {
  const result = route({
    orgId: 'org-1',
    userMessage: 'tell me about the founders of darexai',
    employees: ROSTER,
  });
  assert.equal(result.destination, 'employee');
  assert.equal(result.employeeName, 'Research');
  assert.equal(result.rosterKey, 'research');
  assert.notEqual(result.employeeName, 'Emma');
});

test('daily brief style messages route to Executive', () => {
  const result = route({
    orgId: 'org-1',
    userMessage: "Give me today's executive brief",
    employees: ROSTER,
  });
  assert.equal(result.destination, 'employee');
  assert.equal(result.employeeName, 'Executive');
  assert.equal(result.rosterKey, 'executive');
});

test('lockToEmployee skips domain routing and marks locked', () => {
  const locked = lockToEmployee(ROSTER[0], 'Locked to Sarah');
  assert.equal(locked.destination, 'employee');
  assert.equal(locked.employeeId, 'emp-sarah');
  assert.equal(locked.locked, true);
  assert.equal(locked.reason, 'Locked to Sarah');
  assert.deepEqual(locked.toolAllowlist, ROSTER[0].toolAllowlist);
});

test('@Executive name lock still wins over founder Research route', () => {
  const result = route({
    orgId: 'org-1',
    userMessage: '@Executive tell me about the founders of darexai',
    employees: ROSTER,
  });
  assert.equal(result.destination, 'employee');
  assert.equal(result.employeeName, 'Executive');
  assert.equal(result.locked, true);
});

test('EMP-B01: an emergency with no dispatch employee never inherits the caller allowlist', () => {
  const routed = route({
    orgId: 'org-1',
    userMessage: 'gas leak, smell of gas in the unit',
    employees: ROSTER.filter((e) => e.role !== 'Dispatch' && e.role !== 'dispatch'),
  });
  assert.equal(routed.destination, 'dispatch');
  const merged = mergeRoutedForCaller(routed, {
    toolAllowlist: ['gmail', 'whatsapp', 'stripe', 'hubspot'],
    employeeName: 'Sarah',
    employeeRole: 'Sales & Lead Gen',
    employeePersona: 'ISA / sales',
  });
  assert.equal(merged.employeeId, undefined);
  assert.deepEqual(merged.toolAllowlist, []);
  assert.notEqual(merged.employeeName, 'Sarah');
  assert.notEqual(merged.employeeRole, 'Sales & Lead Gen');
});

test('mergeRoutedForCaller: the caller\'s own employee with no card tools still gets the caller fallback', () => {
  const routed = lockToEmployee({ ...ROSTER[0], toolAllowlist: [] }, 'name lock');
  const merged = mergeRoutedForCaller(routed, {
    employeeId: ROSTER[0].id,
    toolAllowlist: ['gmail', 'whatsapp'],
    employeeName: 'fallback',
    employeeRole: 'fallback-role',
    employeePersona: 'fallback-persona',
  });
  assert.deepEqual(merged.toolAllowlist, ['gmail', 'whatsapp']);
});

test('EMP-B02: a different employee with no card tools does not inherit the webhook default allowlist', () => {
  const routed = lockToEmployee({ ...ROSTER[0], toolAllowlist: [], persona: '' }, 'name lock');
  const caller = {
    employeeId: 'emp-webhook-default',
    toolAllowlist: ['stripe', 'whatsapp', 'gmail'],
    employeeName: 'Customer',
    employeeRole: 'Customer Support',
    employeePersona: 'customer persona',
  };
  const merged = mergeRoutedForCaller(routed, caller);
  assert.equal(merged.employeeId, ROSTER[0].id);
  assert.deepEqual(merged.toolAllowlist, []);
  assert.equal(merged.employeePersona, '');
  // No caller id at all: the list belongs to nobody, so it is not inherited either.
  assert.deepEqual(mergeRoutedForCaller(routed, { ...caller, employeeId: undefined }).toolAllowlist, []);
});

const FULL_ROSTER: RouteEmployee[] = [
  ...ROSTER,
  { id: 'emp-ops', name: 'Operations', role: 'Operations', persona: 'Ops', toolAllowlist: ['google-sheets', 'database_query'], status: 'active' },
  { id: 'emp-growth', name: 'Growth', role: 'Growth', persona: 'Growth', toolAllowlist: ['apollo', 'web_search'], status: 'active' },
];

function routeTo(message: string): string {
  return route({ orgId: 'org-1', userMessage: message, employees: FULL_ROSTER }).employeeName;
}

test('operations brief and overdue asks go to Operations, not the generic Research rule', () => {
  assert.equal(routeTo('Give me an operations brief of what is overdue or needs attention.'), 'Operations');
  assert.equal(routeTo('what is overdue right now'), 'Operations');
});

test('overdue invoices stay with Finance', () => {
  assert.equal(routeTo('chase the overdue invoice for Acme'), 'Finance');
});

test('revenue / MRR questions go to Finance', () => {
  assert.equal(routeTo('What is our monthly recurring revenue?'), 'Finance');
  assert.equal(routeTo('what is our MRR'), 'Finance');
});

test('prospecting asks go to Growth; refund asks stay with support', () => {
  assert.equal(routeTo('Find 5 B2B SaaS companies in Bangalore we could sell to.'), 'Growth');
  assert.notEqual(routeTo('A customer wants a refund for order 1042. What should we do?'), 'Growth');
});

test('who-are-you questions go to front-line support, not Research', () => {
  const routed = route({ orgId: 'org-1', userMessage: 'Hi, who are you and what can you do for me?', employees: FULL_ROSTER });
  assert.equal(routed.employeeName, 'Emma');
  assert.match(routed.reason, /about the assistant/);
});

test('email and inbox triage questions go to Emma / Support, not Executive', () => {
  assert.equal(routeTo('fetch my recent emails'), 'Emma');
  assert.equal(routeTo('check my unread emails in Gmail'), 'Emma');
  assert.equal(routeTo('triage my inbox'), 'Emma');
});

