import assert from 'node:assert/strict';
import test from 'node:test';
import { outlookListUrl, outlookMessagePath } from './microsoft-outlook.js';
import { slackTs } from './slack.js';
import { phoneKey } from './whatsapp.js';
import { igRecipientId } from './instagram.js';
import { resolveCallRisk } from '../tool-executor.js';
import { TOOLS } from '../tool-definitions.js';

test('outlook search sets $search, strips quotes and clamps the count', () => {
  const url = new URL(outlookListUrl(500, ' from:alice "invoice" '));
  assert.equal(url.searchParams.get('$search'), '"from:alice invoice"');
  assert.equal(url.searchParams.get('$top'), '50');
  assert.equal(new URL(outlookListUrl('x')).searchParams.has('$search'), false);
  assert.equal(new URL(outlookListUrl('x')).searchParams.get('$top'), '10');
});

test('outlook message ids are validated and encoded before reaching Graph', () => {
  assert.equal(
    outlookMessagePath({ messageId: 'AAMkAGI2T/G=_-+' }),
    'https://graph.microsoft.com/v1.0/me/messages/AAMkAGI2T%2FG%3D_-%2B',
  );
  assert.equal(outlookMessagePath({ messageId: '../../users' }), null);
  assert.equal(outlookMessagePath({ messageId: 'abc?x=1' }), null);
  assert.equal(outlookMessagePath({}), null);
});

test('slack thread ts must look like a Slack timestamp', () => {
  assert.equal(slackTs('1712345678.123456'), '1712345678.123456');
  assert.equal(slackTs(' 1712345678.1 '), '1712345678.1');
  assert.equal(slackTs('1712345678'), null);
  assert.equal(slackTs('abc&channel=x'), null);
});

test('whatsapp phone key matches on the last 10 digits', () => {
  assert.equal(phoneKey('+91 98765-43210'), '9876543210');
  assert.equal(phoneKey('9876543210'), '9876543210');
  assert.equal(phoneKey('12'), null);
});

test('new chat actions read, draft and send at the right risk', () => {
  const cases: Array<[string, string, string, boolean]> = [
    ['microsoft-outlook', 'read_message', 'read', false],
    ['microsoft-outlook', 'draft_reply', 'draft', false],
    ['microsoft-outlook', 'reply_email', 'send', true],
    ['slack', 'list_channels', 'read', false],
    ['slack', 'read_thread', 'read', false],
    ['slack', 'send_reply', 'send', true],
    ['whatsapp', 'list_messages', 'read', false],
    ['whatsapp', 'send_whatsapp_message', 'send', true],
  ];
  for (const [tool, action, risk, confirm] of cases) {
    assert.deepEqual(resolveCallRisk(tool, action), { risk, confirm }, `${tool}.${action}`);
  }
});

test('every new chat tool is defined against its provider action', () => {
  const byName = new Map(TOOLS.map((t) => [t.name, `${t.tool}.${t.action}`]));
  assert.equal(byName.get('outlook_read_message'), 'microsoft-outlook.read_message');
  assert.equal(byName.get('outlook_reply'), 'microsoft-outlook.reply_email');
  assert.equal(byName.get('outlook_draft_reply'), 'microsoft-outlook.draft_reply');
  assert.equal(byName.get('slack_list_channels'), 'slack.list_channels');
  assert.equal(byName.get('slack_read_thread'), 'slack.read_thread');
  assert.equal(byName.get('slack_reply_thread'), 'slack.send_reply');
  assert.equal(byName.get('whatsapp_list_messages'), 'whatsapp.list_messages');
});

test('instagram recipient ids must be numeric IGSIDs', () => {
  assert.equal(igRecipientId(' 17841400000000001 '), '17841400000000001');
  assert.equal(igRecipientId('../me/messages'), null);
  assert.equal(igRecipientId('1234'), null);
  assert.equal(igRecipientId(undefined), null);
});

test('instagram chat tools read and send at the right risk', () => {
  assert.deepEqual(resolveCallRisk('instagram', 'list_messages'), { risk: 'read', confirm: false });
  assert.deepEqual(resolveCallRisk('instagram', 'send_dm'), { risk: 'send', confirm: true });
  const byName = new Map(TOOLS.map((t) => [t.name, `${t.tool}.${t.action}`]));
  assert.equal(byName.get('instagram_list_messages'), 'instagram.list_messages');
  assert.equal(byName.get('instagram_send'), 'instagram.send_dm');
});
