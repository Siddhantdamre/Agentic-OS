/**
 * The one-way rule: a change an AI employee proposes to itself may make it more careful, never more powerful.
 * Anything that widens its tools, its autonomy, or removes a human check is refused outright, whatever its test score.
 */

export interface Policy {
  text: string;
  /** Tool names the employee may call. */
  toolAllowlist: string[];
  /** Autonomy stage, higher means more is done without asking. */
  autonomyStage: number;
  /** Actions that must wait for a person, by name. */
  approvalRequired: string[];
}

export interface GuardResult {
  safe: boolean;
  reasons: string[];
}

/** Each clause is one promise to the owner. A candidate that drops the wording of one is refused. */
export const PROTECTED_CLAUSES: { id: string; label: string; phrases: string[] }[] = [
  { id: 'approval-before-sending', label: 'ask the owner before sending', phrases: ['approval before sending', 'approval-before-sending', 'ask the owner before sending', 'wait for approval before sending'] },
  { id: 'never-promise-refunds', label: 'never promise refunds', phrases: ['never promise refunds', 'never promise a refund', 'do not promise refunds', 'never-promise-refunds'] },
  { id: 'escalate-complaints', label: 'hand complaints to a person', phrases: ['escalate complaints', 'escalate-complaints', 'escalate every complaint', 'hand complaints to'] },
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');
const has = (text: string, c: { phrases: string[] }) => c.phrases.some((p) => norm(text).includes(norm(p)));

export function assertSafeChange(current: Policy, candidate: Policy): GuardResult {
  const reasons: string[] = [];
  const cur = new Set(current.toolAllowlist.map((t) => t.toLowerCase()));
  const added = [...new Set(candidate.toolAllowlist.map((t) => t.toLowerCase()))].filter((t) => !cur.has(t));
  if (added.length) reasons.push(`It adds ${added.length === 1 ? 'a tool' : 'tools'} the employee did not have: ${added.join(', ')}. An employee cannot give itself new tools.`);

  if (!Number.isFinite(candidate.autonomyStage)) reasons.push('Its autonomy level is not a valid number, so it cannot be checked.');
  else if (candidate.autonomyStage > current.autonomyStage) reasons.push(`It raises the autonomy stage from ${current.autonomyStage} to ${candidate.autonomyStage}. Only a person can give an employee more freedom.`);

  const candApprovals = new Set(candidate.approvalRequired.map((a) => a.toLowerCase()));
  const dropped = current.approvalRequired.filter((a) => !candApprovals.has(a.toLowerCase()));
  if (dropped.length) reasons.push(`It removes the need for a person to approve: ${dropped.join(', ')}.`);

  for (const c of PROTECTED_CLAUSES) {
    if (has(current.text, c) && !has(candidate.text, c)) reasons.push(`It removes the rule to ${c.label}.`);
  }
  return { safe: reasons.length === 0, reasons };
}
