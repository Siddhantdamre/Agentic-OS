import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_CREW_SPAWN,
  MANAGER_SYNTHESIS_TIMEOUT,
  MANAGER_SYNTHESIS_TIMEOUT_MS,
  capCrewSpecialists,
  buildCrewSynthesisPrompt,
  fallbackCrewReply,
} from './crew-contract.js';

test('MAX_CREW_SPAWN hard-caps at 3', () => {
  assert.equal(MAX_CREW_SPAWN, 3);
  const capped = capCrewSpecialists([1, 2, 3, 4]);
  assert.deepEqual(capped, [1, 2, 3]);
  assert.equal(capCrewSpecialists([]).length, 0);
  assert.equal(capCrewSpecialists([1]).length, 1);
  assert.equal(capCrewSpecialists([1, 2, 3]).length, 3);
});

test('manager synthesis timeout is bounded', () => {
  assert.equal(MANAGER_SYNTHESIS_TIMEOUT, '3 minutes');
  assert.equal(MANAGER_SYNTHESIS_TIMEOUT_MS, 180_000);
});

test('buildCrewSynthesisPrompt includes specialist failures honestly', () => {
  const prompt = buildCrewSynthesisPrompt('Summarize pipeline', [
    { employeeName: 'Marcus', employeeRole: 'Ops', task: 'Analyze', reply: 'Deal count is 12' },
    { employeeName: 'Faulty', employeeRole: 'Broken', task: 'Fetch', reply: 'Specialist execution failed' },
  ]);
  assert.match(prompt, /Marcus/);
  assert.match(prompt, /Deal count is 12/);
  assert.match(prompt, /Specialist execution failed/);
  assert.match(prompt, /notConnected/);
  assert.match(prompt, /do not invent facts/i);
  assert.doesNotMatch(prompt, /do not pretend that person was not on the team/i);
});

test('buildCrewSynthesisPrompt truncates huge specialist reports', () => {
  const huge = 'y'.repeat(10_000);
  const prompt = buildCrewSynthesisPrompt('x', [
    { employeeName: 'Verbose', employeeRole: 'Ops', task: 'Dump', reply: huge },
  ]);
  assert.match(prompt, /truncated/);
  assert.ok(prompt.length < 8_000);
});

test('fallbackCrewReply surfaces specialist reports when the manager wrote nothing', () => {
  const text = fallbackCrewReply([
    { employeeName: 'Research', result: { replyMessage: 'Competitor A is priced at $10.' } },
    { employeeName: 'Growth', result: { replyMessage: '   ' } },
  ]);
  assert.match(text, /did not write a summary/);
  assert.match(text, /\*\*Research\*\*\nCompetitor A is priced at \$10\./);
  assert.doesNotMatch(text, /\*\*Growth\*\*/);
});

test('fallbackCrewReply is honest when no specialist wrote anything either', () => {
  const text = fallbackCrewReply([{ employeeName: 'Research', result: { error: 'timeout' } }]);
  assert.match(text, /no specialist returned a written result/);
});
