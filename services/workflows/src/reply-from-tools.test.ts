import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPlaceholderReply, readModelText, replyForPausedTurn, replyForTurn, synthesizeReplyFromTools } from './reply-from-tools.js';

test('reads model text out of a content-block object', () => {
  const text = readModelText({ content: [{ type: 'text', text: 'Sanu Shaurya founded DarexAI.' }] });
  assert.equal(text, 'Sanu Shaurya founded DarexAI.');
});

test('replaces the empty-turn placeholder with search hits', () => {
  const reply = replyForTurn('I have completed the task.', [
    {
      tool: 'web_search',
      result: `\n<untrusted_tool_data>\n${JSON.stringify({
        status: 'executed',
        message: 'Found 1',
        data: {
          query: 'founders of darexai',
          results: [
            {
              title: 'Sanu Shaurya — Founder',
              url: 'https://www.linkedin.com/in/sanu',
              snippet: 'Founder at DarexAI &amp;amp; team',
            },
          ],
        },
      })}\n</untrusted_tool_data>\n`,
    },
  ]);
  assert.equal(isPlaceholderReply(reply), false);
  assert.match(reply, /founders of darexai/);
  assert.match(reply, /Sanu Shaurya/);
  assert.match(reply, /linkedin\.com/);
  assert.doesNotMatch(reply, /\[object Object\]/);
  assert.doesNotMatch(reply, /untrusted_tool_data/);
});

test('a pointer sentence is replaced when the pages do not name a founder', () => {
  const reply = replyForTurn('The matching pages are listed with the search above.', [
    {
      tool: 'web_search',
      result: JSON.stringify({
        data: {
          query: 'founders of darexai',
          results: [
            { title: 'Darex AI', url: 'https://darexai.com', snippet: 'AI automation and voice agents.' },
          ],
        },
      }),
    },
  ]);
  assert.match(reply, /None of these pages name an individual founder/);
  assert.match(reply, /voice agents/);
  assert.doesNotMatch(reply, /matching pages are listed/);
});

test('an unsigned tool reply points at that account', () => {
  const reply = synthesizeReplyFromTools([
    {
      tool: 'gmail_send',
      result: JSON.stringify({
        status: 'error',
        message: 'gmail is not signed in',
        data: { connected: false, setupUrl: '/connectors?connect=gmail' },
      }),
    },
    {
      tool: 'drive_list',
      result: JSON.stringify({ status: 'error', message: 'not signed in', data: { connected: false } }),
    },
    {
      tool: 'outlook_send',
      result: JSON.stringify({ status: 'error', message: 'not connected', data: { connected: false } }),
    },
  ]);
  assert.match(reply, /\/connectors\?connect=gmail/);
  assert.match(reply, /\/connectors\?connect=google-drive/);
  assert.match(reply, /\/connectors\?connect=microsoft-outlook/);
});

test('keeps a real model sentence', () => {
  const reply = replyForTurn('Sanu Shaurya is the founder.', [
    { tool: 'web_search', result: '{"message":"unused"}' },
  ]);
  assert.equal(reply, 'Sanu Shaurya is the founder.');
});

test('a search outage is not reported as the pages having nothing', () => {
  const reply = replyForTurn('I have completed the task.', [
    {
      tool: 'web_search',
      result: JSON.stringify({
        status: 'error',
        message: 'Web search is unavailable right now (rate_limited)',
        data: { query: 'acme funding', results: [], reason: 'rate_limited' },
      }),
    },
  ]);
  assert.match(reply, /couldn't check the web for “acme funding”/);
  assert.match(reply, /rate-limiting/);
  assert.doesNotMatch(reply, /none of the pages/);
});

test('a turn paused for approval with no model text says what is waiting', () => {
  assert.equal(
    replyForPausedTurn('', ['mcp.darex.gmail_draft_email']),
    'This needs your approval before it runs: gmail draft email. Approve or deny it below. Nothing has been sent yet.',
  );
  assert.match(replyForPausedTurn('The search finished, but there was nothing readable to show.', ['gmail_send']) || '', /needs your approval/);
  assert.equal(replyForPausedTurn('I drafted the reply below for your approval.', ['gmail_draft_email']), null);
});
