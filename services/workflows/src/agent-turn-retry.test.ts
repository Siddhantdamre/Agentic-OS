import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentTaskInput, AgentTaskResult } from './agent-engine.js';
import {
  agentTurnClaimKey,
  runGuardedAgentTurn,
  TURN_RETRY_HELD_ERROR,
  type TurnClaimStore,
} from './activities/index.js';
import { ESCALATION_HOLDING_REPLY } from './customer/confidence-gate.js';

const ORG = '00000000-0000-4000-8000-0000000000c3';
const KEY = 'wf:wf-1:run-1:agent-turn:1';

function input(extra: Partial<AgentTaskInput> = {}): AgentTaskInput {
  return { orgId: ORG, userMessage: 'refund order 42', ...extra } as AgentTaskInput;
}

const ok: AgentTaskResult = {
  success: true,
  replyMessage: 'Refunded.',
  executedSteps: [{ step: 1, action: 'stripe_refund', result: 'ok' }],
  usedTools: ['stripe_refund'],
  isDone: true,
};

/** In-memory stand-in for idempotency_keys: null result = in-flight claim. */
function memoryStore(): TurnClaimStore & { rows: Map<string, AgentTaskResult | null> } {
  const rows = new Map<string, AgentTaskResult | null>();
  return {
    rows,
    async claim(_org, key) {
      if (!rows.has(key)) {
        rows.set(key, null);
        return { claimed: true, cached: null };
      }
      return { claimed: false, cached: rows.get(key) ?? null };
    },
    async write(_org, key, result) {
      rows.set(key, result);
    },
  };
}

test('first attempt claims, runs once and records the result', async () => {
  const store = memoryStore();
  let runs = 0;
  const res = await runGuardedAgentTurn(input(), KEY, async () => (runs++, ok), store);
  assert.equal(runs, 1);
  assert.deepEqual(res, ok);
  assert.deepEqual(store.rows.get(KEY), ok);
});

test('retry after an unfinished attempt does not run the turn again', async () => {
  const store = memoryStore();
  store.rows.set(KEY, null); // attempt 1 timed out mid-turn
  let runs = 0;
  const res = await runGuardedAgentTurn(input(), KEY, async () => (runs++, ok), store);
  assert.equal(runs, 0);
  assert.equal(res.success, false);
  assert.equal(res.error, TURN_RETRY_HELD_ERROR);
  assert.equal(res.retryable, false);
  assert.deepEqual(res.usedTools, []);
});

test('customer-facing held retry uses the escalation holding reply', async () => {
  const store = memoryStore();
  store.rows.set(KEY, null);
  const res = await runGuardedAgentTurn(input({ customerIdentifier: '+15550100' }), KEY, async () => ok, store);
  assert.equal(res.replyMessage, ESCALATION_HOLDING_REPLY);
});

test('retry after a finished attempt returns the recorded result without running', async () => {
  const store = memoryStore();
  store.rows.set(KEY, ok);
  let runs = 0;
  const res = await runGuardedAgentTurn(input(), KEY, async () => (runs++, ok), store);
  assert.equal(runs, 0);
  assert.deepEqual(res, ok);
});

test('claim errors other than a missing table are thrown, not run unguarded', async () => {
  let runs = 0;
  const store: TurnClaimStore = {
    claim: async () => {
      throw new Error('connection refused');
    },
    write: async () => {},
  };
  await assert.rejects(runGuardedAgentTurn(input(), KEY, async () => (runs++, ok), store), /connection refused/);
  assert.equal(runs, 0);
});

test('missing idempotency_keys table runs the turn without a guard', async () => {
  let runs = 0;
  const store: TurnClaimStore = {
    claim: async () => {
      throw Object.assign(new Error('relation "idempotency_keys" does not exist'), { code: '42P01' });
    },
    write: async () => {
      throw new Error('must not write after a failed claim');
    },
  };
  const res = await runGuardedAgentTurn(input(), KEY, async () => (runs++, ok), store);
  assert.equal(runs, 1);
  assert.deepEqual(res, ok);
});

test('no key (outside an activity) runs the turn directly', async () => {
  assert.equal(agentTurnClaimKey(), undefined);
  let runs = 0;
  await runGuardedAgentTurn(input(), undefined, async () => (runs++, ok), memoryStore());
  assert.equal(runs, 1);
});

test('"does not exist" errors that are not a missing table still block the turn', async () => {
  let runs = 0;
  const store: TurnClaimStore = {
    claim: async () => {
      throw Object.assign(new Error('role "darex_app" does not exist'), { code: '28000' });
    },
    write: async () => {},
  };
  await assert.rejects(runGuardedAgentTurn(input(), KEY, async () => (runs++, ok), store), /does not exist/);
  assert.equal(runs, 0);
});
