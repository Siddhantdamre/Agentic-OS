import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFixedMemberCrew } from '@darex/shared-types';
import {
  MAX_CREW_SPAWN,
  buildCrewSynthesisPrompt,
  buildFixedMemberPersonaSuffix,
  capCrewSpecialists,
  prepareFixedMemberSpecialists,
} from './crew-contract.js';

test('cap slices 4 specialists to 3', () => {
  assert.equal(MAX_CREW_SPAWN, 3);
  const four = [
    { id: 'a', name: 'A', role: 'Ops' },
    { id: 'b', name: 'B', role: 'Finance' },
    { id: 'c', name: 'C', role: 'Growth' },
    { id: 'd', name: 'D', role: 'Research' },
  ];
  const capped = capCrewSpecialists(four);
  assert.equal(capped.length, 3);
  assert.deepEqual(
    capped.map((m) => m.id),
    ['a', 'b', 'c'],
  );
});

test('fixed member list is not replaced by a planner', () => {
  // Greeting would be solo under heuristicCrewPlan / planCrew; Team mode keeps the set.
  const members = [
    { id: 'fin-1', name: 'Finance', role: 'Finance' },
    { id: 'ops-1', name: 'Operations', role: 'Operations' },
    { id: 'mkt-1', name: 'Marcus', role: 'Marketing' },
  ];
  const plan = planFixedMemberCrew(members, 'hi');
  assert.equal(plan.mode, 'crew');
  assert.equal(plan.specialists.length, 3);
  assert.deepEqual(
    plan.specialists.map((s) => s.employeeId),
    ['fin-1', 'ops-1', 'mkt-1'],
  );
  assert.match(plan.reason, /Fixed Team/i);
});

test('a member the planner would have dropped is still present', () => {
  // Domain auto-pick on "hi" would drop Finance/Ops; fixed plan keeps them.
  const members = [
    { id: 'fin-1', name: 'Finance', role: 'Finance' },
    { id: 'ops-1', name: 'Operations', role: 'Operations' },
  ];
  const plan = planFixedMemberCrew(members, 'hi there');
  assert.equal(plan.specialists.length, 2);
  assert.ok(plan.specialists.some((s) => s.employeeId === 'fin-1'));
  assert.ok(plan.specialists.some((s) => s.employeeId === 'ops-1'));
});

test('"nothing for me" instruction is on the fixed-member prompt', () => {
  const suffix = buildFixedMemberPersonaSuffix('Finance');
  assert.match(suffix, /nothing for me/i);
  assert.match(suffix, /Finance/);
  assert.match(suffix, /do not call tools/i);

  const prepared = prepareFixedMemberSpecialists(
    [
      {
        employeeName: 'Finance',
        employeePersona: 'Careful with money.',
        userMessage: 'hi',
      },
      {
        employeeName: 'Operations',
        employeePersona: 'Sheets first.',
        userMessage: 'hi',
      },
    ],
    'hi',
  );
  assert.equal(prepared.length, 2);
  for (const spec of prepared) {
    assert.match(spec.employeePersona, /nothing for me/i);
    assert.match(spec.employeePersona, new RegExp(spec.employeeName));
  }
});

test('fixed-member synthesis keeps nothing-for-me reports', () => {
  const prompt = buildCrewSynthesisPrompt(
    'hi',
    [
      {
        employeeName: 'Finance',
        employeeRole: 'Finance',
        task: 'hi',
        reply: 'nothing for me — Finance',
      },
      {
        employeeName: 'Operations',
        employeeRole: 'Ops',
        task: 'hi',
        reply: 'Hello from Ops',
      },
    ],
    { fixedMembers: true },
  );
  assert.match(prompt, /nothing for me/i);
  assert.match(prompt, /do not pretend that person was not on the team/i);
  assert.match(prompt, /Finance/);
  assert.match(prompt, /Operations/);
});
