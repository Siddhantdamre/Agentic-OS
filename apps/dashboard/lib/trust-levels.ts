/**
 * What each autonomy level lets the team do on its own, as the gate really behaves.
 *
 * The data is trust-levels.json. It is not a statement of intent: a workflows test
 * (trust-levels-parity.test.ts) runs the real gate for every level and every action
 * class and fails if this table is wrong. The words the customer reads live in the page.
 */
import table from './trust-levels.json';
import type { RolloutStage } from './employee-rollout';

export type Outcome = 'runs' | 'asks' | 'recorded';
export type Risk = 'read' | 'draft' | 'send' | 'publish' | 'sign' | 'pay' | 'delete' | 'execute';
export type ActionGroupId = 'look_up' | 'draft' | 'send_publish' | 'pay_delete' | 'sign_execute';

/** Action classes that behave the same at every level are shown as one row. */
export const ACTION_GROUPS: ReadonlyArray<{ id: ActionGroupId; risks: readonly Risk[] }> = [
  { id: 'look_up', risks: ['read'] },
  { id: 'draft', risks: ['draft'] },
  { id: 'send_publish', risks: ['send', 'publish'] },
  { id: 'pay_delete', risks: ['pay', 'delete'] },
  { id: 'sign_execute', risks: ['sign', 'execute'] },
];

const STAGES = table.stages as Record<string, Record<string, Outcome>>;

export function levelRows(stage: RolloutStage): Array<{ group: ActionGroupId; outcome: Outcome }> {
  return ACTION_GROUPS.map((g) => ({ group: g.id, outcome: STAGES[String(stage)][g.risks[0]] }));
}

/** True when this level allows exactly what the one below it allows. */
export function sameAsPreviousLevel(stage: RolloutStage): boolean {
  if (stage === 0) return false;
  const here = levelRows(stage).map((r) => r.outcome).join();
  const below = levelRows((stage - 1) as RolloutStage).map((r) => r.outcome).join();
  return here === below;
}
