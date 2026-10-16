import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MACHINE_INITIAL,
  MACHINE_TABLES,
  assertTransition,
  reachableFrom,
} from '@darex/shared-types';

test('assertTransition allows self-replay and rejects illegal moves', () => {
  assert.doesNotThrow(() => assertTransition('enquiry', 'new', 'new'));
  assert.doesNotThrow(() => assertTransition('enquiry', 'new', 'assigned'));
  assert.throws(() => assertTransition('enquiry', 'closed', 'new'), /illegal enquiry/);
  assert.throws(() => assertTransition('open_loop', 'resolved', 'new'), /unknown open_loop/);
});

test('every machine state is reachable from its initial state', () => {
  for (const [machine, table] of Object.entries(MACHINE_TABLES)) {
    const name = machine as keyof typeof MACHINE_TABLES;
    for (const [from, tos] of Object.entries(table)) {
      for (const to of tos) {
        assert.ok(to in table, `${machine}: ${from} -> ${to} targets unknown state`);
      }
    }
    const reached = reachableFrom(table, MACHINE_INITIAL[name]);
    assert.equal(reached.size, Object.keys(table).length, `${machine} has unreachable states`);
    const terminals = Object.entries(table).filter(([, t]) => t.length === 0);
    assert.ok(terminals.length >= 1, `${machine} needs a terminal state`);
  }
});
