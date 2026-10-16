/**
 * A trust decision the owner can read, and an auditor can re-derive.
 *
 * "The AI decided to stop asking" is the sentence that ends a buyer's trust the
 * first time it is unexplained. Every decision therefore carries a receipt: the
 * evidence it used, where each piece came from, the exact numbers, and the
 * rule. Nothing in the receipt is a float, so re-running the rule on the same
 * inputs reproduces it character for character.
 */
import { q, toDecimal } from './rational';
import type { Decision } from './posterior';

/** "a/b" (an exact fraction as text) as a percentage. Display only. */
const pct = (fraction: string, places = 1): string => {
  const [n, d] = fraction.includes('/') ? fraction.split('/') : [fraction, '1'];
  return toDecimal(q(BigInt(n) * 100n, BigInt(d)), places) + '%';
};

const WHY: Record<Decision['reason'], string> = {
  not_graduatable: 'This kind of action is never allowed to run without a person (payments, signatures, legal, compliance stops).',
  needs_local_evidence: 'Other workspaces have not been enough: your own team has to approve a few of these first.',
  hive_caution: 'Held. Across other workspaces this kind of action is usually rejected, so it is held to a stricter standard: it needs more of your own approvals, at higher confidence, before it stops asking.',
  posterior_insufficient: 'Not yet. The evidence does not yet make it likely enough that you would keep approving these.',
  posterior_sufficient: 'Ready. The evidence makes it very likely you would keep approving these.',
};

export interface Receipt {
  headline: string;
  lines: string[];
  /** Everything needed to recompute the verdict, as exact strings. */
  reproduce: Decision;
}

export function receipt(actionClass: string, d: Decision): Receipt {
  const lines: string[] = [];
  lines.push(
    `Your team: ${d.local.approvals} approved, ${d.local.rejections} rejected` +
      (d.local.lockedOut ? ' (you said no recently, so other workspaces are not counted until you re-earn this).' : '.'),
  );
  if (d.prior.used) {
    lines.push(
      `Other workspaces that chose to share: counted as ${d.prior.approvals} approved, ${d.prior.rejections} rejected ` +
        `(capped at ${d.prior.weight} observations so your own history always outweighs it).`,
    );
  } else {
    lines.push('Other workspaces: not used.');
  }
  if (d.veto.evaluated) {
    lines.push(
      d.veto.triggered
        ? `Across other workspaces this action is usually rejected (chance the shared approval rate is under ${pct(d.policy.vetoTau, 0)}: ${pct(d.veto.pCohortBelowVetoTau!)}), so other workspaces are not counted and the bar is higher: at least ${d.policy.cautionMinLocalApprovals} of your own approvals and at most a ${pct(d.policy.cautionDelta, 0)} chance the rate is low.`
        : 'Across other workspaces this action is not usually rejected.',
    );
  }
  lines.push(
    `Chance your approval rate is below ${pct(d.policy.tau, 0)}: ${pct(d.pBelowTau, 2)} ` +
      `(needs to be at most ${pct(d.delta, 0)}). Evidence: Beta(${d.posterior.alpha}, ${d.posterior.beta}).`,
  );
  lines.push(WHY[d.reason]);
  return {
    headline: `${actionClass}: ${d.verdict === 'graduate' ? 'may stop asking' : 'keeps asking'}`,
    lines,
    reproduce: d,
  };
}

export const receiptText = (actionClass: string, d: Decision): string => {
  const r = receipt(actionClass, d);
  return [r.headline, ...r.lines.map((l) => '  - ' + l)].join('\n');
};
