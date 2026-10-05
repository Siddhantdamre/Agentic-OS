import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRawEmail, gmailHttpFailure, gmailListUrl, replySubject } from './gmail.js';
import { resolveCallRisk } from '../tool-executor.js';

test('gmail 401 is revoked, not an empty inbox', () => {
  const result = gmailHttpFailure('fetch_latest_emails', '2026-09-27T00:00:00.000Z', 401);
  assert.equal(result.status, 'error');
  assert.equal(result.data?.reason, 'revoked');
});

test('gmail 500 is an api error', () => {
  const result = gmailHttpFailure('fetch_latest_emails', '2026-09-27T00:00:00.000Z', 500);
  assert.equal(result.status, 'error');
  assert.equal(result.data?.reason, 'api_error');
});

test('gmail search passes the query as q, encoded, and clamps the count (TOOL-G01)', () => {
  const url = new URL(gmailListUrl(5, '  from:alice@acme.com subject:"Q3 invoice" '));
  assert.equal(url.searchParams.get('q'), 'from:alice@acme.com subject:"Q3 invoice"');
  assert.equal(url.searchParams.get('maxResults'), '5');
  assert.equal(new URL(gmailListUrl(500)).searchParams.get('maxResults'), '50');
  assert.equal(new URL(gmailListUrl('x')).searchParams.get('maxResults'), '10');
  assert.equal(new URL(gmailListUrl(10, '   ')).searchParams.has('q'), false);
  assert.equal(new URL(gmailListUrl(10, 'a'.repeat(900))).searchParams.get('q')?.length, 500);
});

test('raw email strips header injection, encodes a unicode subject, and threads replies', () => {
  const raw = Buffer.from(
    buildRawEmail({
      to: 'a@b.co\r\nBcc: evil@x.co',
      subject: 'Réunion\nX-Evil: 1',
      body: 'héllo',
      cc: 'c@d.co',
      inReplyTo: '<m1@mail.gmail.com>',
      references: '<m0@mail.gmail.com> <m1@mail.gmail.com>',
    }),
    'base64url',
  ).toString('utf8');
  const headers = raw.split('\r\n\r\n')[0].split('\r\n');
  assert.ok(headers.includes('To: a@b.co Bcc: evil@x.co'));
  assert.equal(headers.filter((h) => h.startsWith('Bcc:')).length, 0);
  assert.equal(headers.filter((h) => h.startsWith('X-Evil')).length, 0);
  assert.ok(headers.includes(`Subject: =?UTF-8?B?${Buffer.from('Réunion X-Evil: 1').toString('base64')}?=`));
  assert.ok(headers.includes('Cc: c@d.co'));
  assert.ok(headers.includes('In-Reply-To: <m1@mail.gmail.com>'));
  assert.ok(headers.includes('References: <m0@mail.gmail.com> <m1@mail.gmail.com>'));
  assert.equal(Buffer.from(raw.split('\r\n\r\n')[1], 'base64').toString('utf8'), 'héllo');
});

test('reply subject adds Re: once', () => {
  assert.equal(replySubject('Invoice'), 'Re: Invoice');
  assert.equal(replySubject('RE: Invoice'), 'RE: Invoice');
  assert.equal(replySubject(''), 'Re: (No Subject)');
});

test('gmail reply and read actions carry the right risk', () => {
  assert.equal(resolveCallRisk('gmail', 'read_email')?.risk, 'read');
  assert.equal(resolveCallRisk('gmail', 'draft_reply')?.risk, 'draft');
  assert.equal(resolveCallRisk('gmail', 'reply_email')?.risk, 'send');
  assert.equal(resolveCallRisk('gmail', 'reply_email')?.confirm, true);
  assert.equal(resolveCallRisk('gmail_reply', 'reply_email')?.risk, 'send');
});
