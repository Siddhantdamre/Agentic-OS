import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isHumanDestination, route, type RouteEmployee } from './route-employee.js';

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

test('greeting stays solo support — never a crew of 8', () => {
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

test('active Finance is selected for payment-link asks', () => {
  const result = route({
    orgId: 'org-1',
    userMessage: 'Create a Razorpay payment link for invoice 1042',
    employees: ROSTER,
  });
  assert.equal(result.employeeName, 'Finance');
  assert.equal(result.rosterKey, 'finance');
});
