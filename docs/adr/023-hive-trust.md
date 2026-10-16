# 23. Trust is learned across workspaces, bounded, and opt-in

**Status:** Proposed. Implemented and tested as an isolated module; **not wired into the
approval flow** and off by default. Needs an independent privacy review and a
sybil-resistance decision before real customer data flows through it.

## Context

Earned autonomy (migration 034) is per workspace. An action class graduates from `ask`
to `notify` after ten approvals in a row, and one rejection sends it back. That rule is
honest, and it has two costs.

**Every workspace starts cold.** It pays the full ten approvals for actions that every
other workspace has already shown to be safe.

**Ten in a row is weak evidence.** Simulated over 150 reviews, it graduates 41% of new
workspaces on a class where their own people would reject more than one action in ten
(`risky`), and 49% on a mixed class. A streak eventually happens by chance.

`00-vision` set a non-goal: "not a multi-tenant shared brain across orgs. Memory never
crosses `org_id`. Industry models may be global; tenant facts may not." This decision
keeps the spirit and changes one word: what crosses is not a tenant fact. It is a pair
of noisy counts per action class, from workspaces that opted in, above a k-threshold.

## Decision

1. **Replace the streak with an exact posterior.** Beta(1 + approvals, 1 + rejections)
   with integer parameters, so the CDF is a finite binomial sum in BigInt rationals.
   A trust decision is a pure function of its inputs, reproducible bit for bit, with a
   receipt that contains every number needed to re-derive it. No floating point
   decides anything.
2. **Let opted-in workspaces borrow a bounded prior.** The released counts are scaled
   to at most `maxPriorWeight` pseudo-observations, and never remove the local floor
   (`minLocalApprovals`). A local rejection switches the prior off for that class: after
   your own "no", you earn it back on your own evidence.
3. **Let the cohort urge caution, not veto.** If the released counts say the class is
   usually rejected, the prior is dropped and the workspace must clear a stricter test
   on its own evidence (20 approvals at δ=0.1). The first design was an outright veto;
   the simulation showed twenty colluding workspaces contributing only rejections
   froze every safe workspace forever.
4. **Four protections, in TypeScript and again in SQL** (migration 348): opt-in plus
   eligibility (paid plan, minimum age, minimum decision volume), per-workspace
   clipping of the total, a k-threshold below which nothing is stored, and
   discrete-Laplace noise derived from a secret key and the release label so a release
   is computed **once**. Counts are computed by the database from `approval_requests`;
   a workspace cannot submit numbers of its choosing.
5. **Reciprocity.** Only a sharing workspace receives a prior (or a caution).

## Results (simulation; seed 20260930; 1,000 new workspaces per cell)

These are experiments on a MODEL of workspaces. They show what the mechanism can do
and where it cannot; they are not evidence about real customers. Reproduce with
`node infra/scripts/simulate-hive-trust.js`.

| Claim | Result |
|---|---|
| **Speed, safe cohort** (workspaces nearly all approve) | Median reviews to stop asking: **5** with the hive, 9 without, 10 today, at the same unsafe-graduation rate (0.7% vs 0.6%). At matched δ=0.05 the hive needs 20 reviews where the local posterior needs 28. |
| **Safety, risky cohort** | Today's streak rule graduates **40.9%** of new workspaces whose true approval rate is below 90%. Posterior alone: 5.9%. With the hive: **0.9%**. |
| **Mixed cohort** | The hive is **not faster**: median 21 reviews vs 9. It is a calibration — 10.0% unsafe vs 13.6% (posterior) and 49.4% (streak). |
| **Heterogeneity** | At a cohort mean of 0.95, the hive cuts mean reviews by 20–31% in every setting tested, with unsafe graduations up by as much as about 2 points when workspaces differ a lot. |
| **Privacy** | An adversary who knows every other workspace and applies the optimal test reaches 60.4% / 70.7% / 81.6% / 92.6% accuracy at ε = 0.5 / 1 / 2 / 4 for one release; the theoretical ceiling is 62.2 / 73.1 / 88.1 / 98.2. Never above it. |
| **Composition** | Ten independent releases at ε=1 raise that adversary to **91.6%**. The budget composes; it is capped at 12 contributing epochs per workspace per year. |
| **Utility** | "Hive size" below is total workspaces, half of which share. At a hive of 100 and ε=2, 99% of decisions are unchanged by noise; at 300, 100%. At 30 (about 15 sharing) up to 12.6% flip (at ε=0.5; 3.3% at ε=4), and at 10, 9–14% flip and 29–44% of cells fall below k=5 and are suppressed. Flips at small sizes go mostly toward asking, not toward acting. |
| **Poisoning (approve-only)** | Unsafe graduations rise from 0.8% to **14.3%** at 1,000 colluders and stay there (bounded by the prior weight cap). No hive: 5–6%. Today's streak: 41%. |
| **Poisoning (reject-only)** | A safe class slows from 5 to 21 median reviews (9 with no hive); ~5% never graduate in 150 reviews. It can no longer be frozen. |

**The weight cap and the local floor are one knob.** The setting that lets an honest hive
speed a workspace up lets a poisoned one push a risky class through:

| (weight, floor) | Safe-class speedup | Unsafe graduations under a 3,000-colluder attack |
|---|---|---|
| (12, 3) ACCELERATED | 2.0× | 26% |
| **(8, 5) DEFAULT** | **1.7×** | **13%** |
| (8, 8) CONSERVATIVE | 1.1× | 6% (≈ no hive) |
| today's streak | — | 41% |

The default is chosen against the worst case. ACCELERATED is appropriate only where
participation is verified, so that a coalition thirty times the honest hive is not cheap.

## Consequences

New workspaces stop asking sooner on actions the cohort has shown to be safe, and
sooner or never on actions it has shown to be risky, with a receipt for each decision.

Cost: a workspace that opts in gives up a little (a noisy, clipped count per class per
epoch); a hive below ~30 sharing workspaces is mostly suppressed and mostly noise;
eligibility rules exclude free-plan workspaces from sharing (a hive below roughly 100 workspaces is mostly noise); a coalition of about a
thousand eligible workspaces can raise unsafe graduations to 14%.

## What breaks if you remove it

Nothing that works today. The streak rule stays the comparison arm. Remove the
receipts and the decision is unexplainable; remove the caution and a rejection-only
coalition can freeze the feature again; remove the once-only release and repeating the
query averages the noise away.

## Evidence

`services/workflows/src/hive/` — 52 tests, including exact-rational equality against an
independent reference for 2,156 (a, b, x) combinations, mutation-tested (three
sabotages of the CDF are caught), and the simulation's conclusions pinned as unit
tests. `check-hive-trust.js` — 37 assertions against real Postgres as the real roles,
including **200 independent releases identical between the SQL sampler and the
TypeScript reference**, and mutation-tested (four sabotages of the SQL are caught; with
clipping off, a twelve-million-decision workspace shifts the total by 12,000,000
instead of 10).

## What this does NOT claim

- It is ε-differential privacy per release for one workspace's contribution under basic
  composition, not an end-to-end proof, and the noise sampler uses floating point (the
  output is an integer). It needs independent privacy review.
- The simulation's workspaces are exchangeable draws from a stated population. Real
  workspaces may differ in ways it does not model, including correlated behaviour across
  a whole industry, which would make a prior confidently wrong.
- Sybil resistance rests on eligibility (paid, aged, active), which raises the cost of a
  coalition but does not make it impossible. This is the parameter that most needs a
  product decision.
- It is not wired into `decide_approval` and has run against no real customer data.
- A release already published cannot be un-mixed after a workspace is erased; that is
  what the noise and the k-threshold are for.
