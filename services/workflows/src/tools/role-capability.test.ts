import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  filterAllowlistForPersona,
  normalizeEmployeePersona,
  roleCapabilityDenial,
} from './role-capability.js';

test('growth keeps apollo and linkedin, drops stripe', () => {
  const filtered = filterAllowlistForPersona(
    ['apollo', 'linkedin', 'hubspot', 'stripe', 'gmail'],
    'growth'
  );
  assert.ok(filtered.includes('apollo'));
  assert.ok(filtered.includes('linkedin'));
  assert.ok(!filtered.includes('stripe'));
});

test('customer keeps stripe, drops apollo and ads', () => {
  const filtered = filterAllowlistForPersona(
    ['stripe', 'apollo', 'google-ads', 'hubspot'],
    'customer'
  );
  assert.ok(filtered.includes('stripe'));
  assert.ok(!filtered.includes('apollo'));
  assert.ok(!filtered.includes('google-ads'));
});

test('null persona leaves the allowlist unfiltered', () => {
  const list = ['apollo', 'stripe', 'linkedin'];
  assert.deepEqual(filterAllowlistForPersona(list, null), list);
  assert.equal(normalizeEmployeePersona(undefined), null);
});

test('operations can use gmail when it is on their allowlist', () => {
  assert.equal(roleCapabilityDenial('operations', 'gmail', 'draft_email', ['gmail', 'slack']), null);
  assert.equal(roleCapabilityDenial('operations', 'gmail', 'send_email', ['gmail']), null);
});

test('customer can log a HubSpot contact they are authorized for, not create deals', () => {
  assert.equal(roleCapabilityDenial('customer', 'hubspot', 'create_crm_contact', ['hubspot']), null);
  assert.ok(roleCapabilityDenial('customer', 'hubspot', 'create_deal', ['hubspot']));
});

test('operations cannot send external email', () => {
  const denial = roleCapabilityDenial('operations', 'gmail', 'send_email');
  assert.match(String(denial), /operations employee cannot/);
});

test('growth cannot refund', () => {
  const denial = roleCapabilityDenial('growth', 'stripe', 'refund_payment');
  assert.ok(denial);
});

test('sarah maps to sales, not customer', () => {
  assert.equal(normalizeEmployeePersona('sarah'), 'sales');
  assert.equal(normalizeEmployeePersona('Sarah'), 'sales');
  assert.equal(normalizeEmployeePersona('Sales & Lead Gen'), 'sales');
  assert.notEqual(normalizeEmployeePersona('sarah'), 'customer');
});

test('sales may use apollo linkedin calendar and hubspot deals, not ads or refunds', () => {
  const filtered = filterAllowlistForPersona(
    ['apollo', 'linkedin', 'google-calendar', 'hubspot', 'google-ads', 'meta-ads', 'gmail'],
    'sarah'
  );
  assert.ok(filtered.includes('apollo'));
  assert.ok(filtered.includes('linkedin'));
  assert.ok(filtered.includes('google-calendar'));
  assert.ok(filtered.includes('hubspot'));
  assert.ok(!filtered.includes('google-ads'));
  assert.ok(!filtered.includes('meta-ads'));
  assert.equal(roleCapabilityDenial('sarah', 'hubspot', 'create_deal', ['hubspot']), null);
  assert.equal(roleCapabilityDenial('Sales & Lead Gen', 'hubspot', 'update_deal', ['hubspot']), null);
  assert.ok(roleCapabilityDenial('sarah', 'stripe', 'refund_payment'));
  assert.ok(roleCapabilityDenial('growth', 'stripe', 'refund_payment'));
});

test('customer cannot create deals or prospect', () => {
  const denial = roleCapabilityDenial('customer', 'hubspot', 'create_deal');
  assert.ok(denial);
  assert.match(String(denial), /customer employee cannot/);
});

test('role allowlist drops denied tools even when caller passes full org allowlist', () => {
  const orgTools = ['gmail', 'google-calendar', 'hubspot', 'stripe', 'apollo', 'linkedin'];
  const opsTools = filterAllowlistForPersona(orgTools, 'operations');
  assert.ok(!opsTools.includes('apollo'));
  assert.ok(!opsTools.includes('linkedin'));
  assert.ok(!opsTools.includes('stripe'));
  assert.ok(opsTools.includes('google-calendar'));
});

test('marketing role string matches Marketing & Analytics', () => {
  assert.equal(normalizeEmployeePersona('Marketing & Analytics'), 'marketing');
  assert.equal(normalizeEmployeePersona('Marcus'), 'marketing');
});

test('marcus is not growth', () => {
  assert.notEqual(normalizeEmployeePersona('marcus'), 'growth');
  assert.equal(normalizeEmployeePersona('marcus'), 'marketing');
  assert.equal(normalizeEmployeePersona('Growth'), 'growth');
});

test('finance persona denies refund', () => {
  const denial = roleCapabilityDenial('Finance', 'stripe', 'create_refund', ['stripe', 'razorpay']);
  assert.ok(denial);
  assert.match(String(denial), /finance employee cannot/);
  assert.equal(normalizeEmployeePersona('Finance'), 'finance');
});

test('marketing cannot create charges or refunds', () => {
  assert.ok(roleCapabilityDenial('Marketing & Analytics', 'stripe', 'create_charge', ['stripe']));
  assert.ok(roleCapabilityDenial('Marcus', 'stripe', 'create_refund', ['stripe']));
  const filtered = filterAllowlistForPersona(
    ['meta-ads', 'google-ads', 'gmail', 'stripe', 'razorpay'],
    'Marketing & Analytics'
  );
  assert.ok(filtered.includes('meta-ads'));
  assert.ok(!filtered.includes('stripe'));
});

