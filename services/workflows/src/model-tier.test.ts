import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseTier, applyTier, type TierCandidate } from './model-tier.js';

const t = (message: string, over: object = {}) => chooseTier({ message, deepAllowed: true, ...over });

test('a simple lookup stays on the fast model', () => {
  assert.equal(t('what time do you open tomorrow?').tier, 'fast');
  assert.equal(t('hi').tier, 'fast');
});

test('money, refunds, complaints and legal questions go to the deep model, in English and Hindi', () => {
  for (const m of [
    'customer wants a refund of 45000',
    'is GST payable on this invoice?',
    'a buyer is threatening legal action',
    'unhone payment nahi kiya, kitna baaki hai',
    'मुझे पैसे वापस चाहिए',
    'draft the agreement for the tenant',
  ]) assert.equal(t(m).tier, 'deep', m);
  for (const m of ['I am interested in the 2bhk', 'fix the syntax of my message']) assert.equal(t(m).tier, 'fast', m);
});

test('analysis and long questions go to the standard model', () => {
  assert.equal(t('compare this month with last month and explain why sales fell').tier, 'standard');
  assert.equal(t('a '.repeat(400)).tier, 'standard');
  assert.equal(t('what is the status?', { hasAttachment: true }).tier, 'standard');
});

test('a spent budget never silently weakens a money answer: it drops one step and says so', () => {
  const r = t('customer wants a refund', { deepAllowed: false });
  assert.equal(r.tier, 'standard');
  assert.match(r.note ?? '', /budget/i);
});

test('a spent budget does not add a note to a plain question', () => {
  assert.equal(t('hi', { deepAllowed: false }).note, undefined);
});

const cands: TierCandidate[] = [
  { name: 'gemini', baseUrl: 'g', apiKey: 'k', model: 'gemini-2.5-flash' },
  { name: 'litellm', baseUrl: 'l', apiKey: 'k', model: 'darex-default' },
];

test('routing is off unless switched on: candidates are returned untouched', () => {
  assert.deepEqual(applyTier(cands, 'deep', {}), cands);
});

test('when on, the gateway candidate leads with the tier alias; others stay as fallbacks', () => {
  const out = applyTier(cands, 'deep', { DAREX_TIER_ROUTING: '1' });
  assert.equal(out[0].name, 'litellm');
  assert.equal(out[0].model, 'darex-deep');
  assert.equal(out.length, 2);
  assert.equal(applyTier(cands, 'standard', { DAREX_TIER_ROUTING: '1' })[0].model, 'darex-standard');
  assert.equal(applyTier(cands, 'fast', { DAREX_TIER_ROUTING: '1' }), cands);
});

test('the alias can be renamed by setting, and no gateway means no change', () => {
  assert.equal(applyTier(cands, 'deep', { DAREX_TIER_ROUTING: '1', DAREX_MODEL_DEEP: 'my-deep' })[0].model, 'my-deep');
  const noGateway = cands.slice(0, 1);
  assert.deepEqual(applyTier(noGateway, 'deep', { DAREX_TIER_ROUTING: '1' }), noGateway);
});
