# Release readiness — Agentic-OS release candidate (17 Oct 2026)

## Verdict: RELEASE CANDIDATE — CONTROLLED PILOT ONLY
Not "RELEASE READY", because the deployable image artifacts have not been built or booted (no Docker daemon in the sandbox) and several launch-relevant areas were never tested against real services. The security surface that was tested holds, and no P0 was found on it.

## 1. What was tested
- Commit: `51cc68a0bbcfcccf80af9330d50abe7c1aee46b8` (main after PR #2; CI app checks green, image workflow red).
- Working tree: clean at start; uncommitted changes now: Dockerfile fix (2 files), inbound send-tool check + 2 regression tests (2 files), reports/.
- Nothing was committed, pushed, merged or deployed. The company-repo merge was paused; its half-resolved work is in a separate folder, unpushed.

## 2. Image-build failure
Root cause and fix in deployment-verification.md: builder stages never copied `services/workflows/scripts/`. Fix = one COPY line in each Dockerfile. Proven with an exact-context reproduction; **real image build and boot BLOCKED (no Docker daemon)**.

## 3. Security
S1-S11 in security-validation.md. Highlights: 119 migrations from zero OK; isolation 13/13; model-SQL 41/41; hive 37/37; 24 hostile token-destination probes through the compiled Shopify/Zendesk tools, 0 token leaks; fail-closed production script refuses all unsafe settings.
One real defect found and fixed in the working tree: **F-1 (P1)** inbound message naming a send tool was no longer parked for a person (nothing was sent, but the safeguard was lost). Fixed test-first; flows 118/118 afterwards.

## 4. Workflows and demo
27 flows / 118 checks pass; three scripted demo rehearsals 14/14 each (about 2 s). All with a simulated model and provider.

## 5. Totals
Workflows 1300/1300; dashboard 1150 pass + 16 DB tests pass (16 skipped in the default run); lint 0; tsc 0; workspace build 6/6.

## 6. Live vs simulated
Everything external is **simulated or untested**: no real model, Gmail, WhatsApp, Shopify, Zendesk, Razorpay, Temporal, Cognee or Hindsight was exercised. Do not describe any integration as "verified live".

## 7. Performance
8-minute single-workspace soak: 530 requests, 0 failures, memory flat. No latency percentiles, no multi-tenant fairness, no capacity number.

## 8. Unresolved items
| ID | Severity | Item | Impact |
|---|---|---|---|
| R-1 | P1 (gate) | Docker images unbuilt/unbooted | Cannot deploy until the image workflow is green |
| R-2 | P1 | Real model quality, tool choice, real connectors untested | Launch claims about answer quality or live integrations are unsupported |
| R-3 | P2 | Temporal restart/retry behaviour and heartbeat interceptor untested | Background-work recovery unproven |
| R-4 | P2 | Latency percentiles, multi-tenant fairness, 24 h soak not measured | No honest capacity statement possible |
| R-5 | P2 | Ambiguous-success (provider acted, we timed out) not injected | Double-send risk on timeout unmeasured |
| R-6 | P2 | Backup/restore/rollback never drilled | Recovery time unknown |
| R-7 | P3 | `main` unprotected; Dependabot PRs #3/#4 pending | Process risk |
| R-8 | note | Dashboard bundles workflows code at build time | Worker fixes need a dashboard rebuild too |

## 9. Recommended launch scope
A controlled pilot with named customers, simulated-or-owner-supervised use only, **after** (a) your authorization to push the Dockerfile + F-1 fix and (b) the GitHub image workflow going green, and (c) one supervised run on the real images. Keep autonomy at "ask first" for sends/payments; do not advertise live integrations or answer quality until a real-model/real-account run is recorded.

## 10. Single highest-value next action
Authorize committing and pushing the two fixes on a branch, so CI builds the images; read that result before anything else.
