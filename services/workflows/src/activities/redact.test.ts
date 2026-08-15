import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactErrorMessage, redactForEmbed } from './redact.js';
import { hashEmbedContent } from './embed.js';

test('strips OpenAI-style API keys', () => {
  const raw = 'Contact Priya. token sk-abcdefghijklmnopqrstuvwxyz0123456789 and done';
  const result = redactForEmbed(raw);
  assert.equal(result.skipped, false);
  assert.match(result.text, /\[REDACTED\]/);
  assert.doesNotMatch(result.text, /sk-abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.ok(result.stripped.includes('api_key'));
});

test('strips OpenRouter and GitHub tokens', () => {
  const raw =
    'keys sk-or-v1-abcdefghijklmnopqrstuvwxyz012345 and ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const result = redactForEmbed(raw);
  assert.equal(result.skipped, false);
  assert.doesNotMatch(result.text, /sk-or-v1-/);
  assert.doesNotMatch(result.text, /ghp_/);
});

test('strips PAN-like patterns and does not keep the id', () => {
  const raw = 'Buyer ABCDE1234F wants 3BHK Andheri West';
  const result = redactForEmbed(raw);
  assert.equal(result.skipped, false);
  assert.doesNotMatch(result.text, /ABCDE1234F/);
  assert.match(result.text, /\[REDACTED\]/);
  assert.match(result.text, /3BHK/);
  assert.ok(result.stripped.includes('pan'));
});

test('does not embed KYC kind documents', () => {
  const result = redactForEmbed('KYC pack for Priya Kapoor', { kind: 'kyc' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'kyc');
  assert.equal(result.text, '');
});

test('does not embed kyc_pointer data class', () => {
  const result = redactForEmbed('Aadhaar on file', { dataClass: 'kyc_pointer' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'kyc');
});

test('redactErrorMessage strips secrets from job errors', () => {
  const cleaned = redactErrorMessage('LiteLLM 401 Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789');
  assert.doesNotMatch(cleaned, /sk-abcdefghijklmnopqrstuvwxyz0123456789/);
});

test('identical bodies produce the same content hash (hash skip key)', () => {
  const body = 'Priya Kapoor wants 3BHK Andheri West';
  const a = hashEmbedContent(body);
  const b = hashEmbedContent(body);
  assert.equal(a, b);
  assert.notEqual(a, hashEmbedContent(`${body} `));
});

test('hash is computed on redacted text so PAN changes do not create a new memory row', () => {
  const first = redactForEmbed('Lead ABCDE1234F wants 3BHK');
  const second = redactForEmbed('Lead ABCDE1234F wants 3BHK');
  assert.equal(hashEmbedContent(first.text), hashEmbedContent(second.text));
});

test('strips a full 16-digit card number, not just the first 12 digits', () => {
  const raw = 'Card 4111-1111-1111-1111 was charged for the deposit';
  const result = redactForEmbed(raw);
  assert.equal(result.skipped, false);
  assert.doesNotMatch(result.text, /\d{4}/);
  assert.doesNotMatch(result.text, /1111/);
  assert.ok(result.stripped.includes('card_pan'));
});

test('still strips a bare 12-digit aadhaar number', () => {
  const raw = 'Aadhaar 1234 5678 9012 on file';
  const result = redactForEmbed(raw);
  assert.equal(result.skipped, false);
  assert.doesNotMatch(result.text, /1234/);
  assert.ok(result.stripped.includes('aadhaar'));
});
