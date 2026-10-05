import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeTurnFailure } from './turn-failure.js';

/**
 * When an AI employee's turn fails, the customer reads the reply in the chat. It used to be
 * "I encountered an issue while processing your request: connect ECONNREFUSED 10.0.0.5:8790", with a step
 * named "TrueForge Agent Turn" whose result was "Error: <the same text>". Internal detail stays in the logs
 * and in `error`; the chat gets one plain sentence.
 */
const INTERNALS = /TrueForge|ECONN|10\.0\.0\.5|8790|fetch failed|SQLSTATE|stack|undefined|Error:/i;

test('a refused connection becomes a plain sentence with no address, port or product name', () => {
  const f = describeTurnFailure('connect ECONNREFUSED 10.0.0.5:8790');
  assert.doesNotMatch(f.replyMessage, INTERNALS);
  assert.doesNotMatch(f.stepAction, INTERNALS);
  assert.doesNotMatch(f.stepResult, INTERNALS);
  assert.match(f.replyMessage, /try again/i);
});

test('a timeout says it took too long, and suggests a shorter ask', () => {
  for (const details of ['The operation was aborted due to timeout', 'request timed out after 180000ms', 'This operation was aborted']) {
    const f = describeTurnFailure(details);
    assert.match(f.replyMessage, /longer than expected|took too long/i);
    assert.doesNotMatch(f.replyMessage, INTERNALS);
  }
});

test('the provider’s error text is never repeated back to the customer', () => {
  const f = describeTurnFailure('TrueForge resume failed (500): {"error":"relation \\"agent_sessions\\" does not exist"}');
  assert.doesNotMatch(`${f.replyMessage} ${f.stepAction} ${f.stepResult}`, /relation|agent_sessions|500|TrueForge/i);
});

test('an empty or missing reason still gives a sentence', () => {
  for (const d of ['', undefined as unknown as string]) {
    const f = describeTurnFailure(d);
    assert.ok(f.replyMessage.length > 20);
    assert.ok(f.stepAction.length > 0 && f.stepResult.length > 0);
  }
});
