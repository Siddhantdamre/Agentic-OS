import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PlanExecuteWorkflow,
  approvePlanSignal,
  rejectPlanSignal,
  planProgressQuery,
} from './workflows/PlanExecuteWorkflow.js';

test('PlanExecuteWorkflow defines proper Temporal signals and query', () => {
  assert.equal(approvePlanSignal.name, 'approvePlan');
  assert.equal(rejectPlanSignal.name, 'rejectPlan');
  assert.equal(planProgressQuery.name, 'planProgressQuery');
});

test('PlanExecuteWorkflow enforces non-empty orgId and planId', async () => {
  await assert.rejects(
    async () => {
      await PlanExecuteWorkflow({ orgId: '', planId: 'plan-1' });
    },
    {
      name: 'ApplicationFailure',
      message: 'orgId is required',
    }
  );

  await assert.rejects(
    async () => {
      await PlanExecuteWorkflow({ orgId: 'org-1', planId: '' });
    },
    {
      name: 'ApplicationFailure',
      message: 'planId is required',
    }
  );
});
