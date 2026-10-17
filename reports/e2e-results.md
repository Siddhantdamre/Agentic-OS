# End-to-end results — Agentic-OS release candidate

Commit: `51cc68a0bbcfcccf80af9330d50abe7c1aee46b8` + uncommitted changes. Stack: production `next start` dashboard, real Postgres (scratch), **simulated** model and **simulated** Gmail/WhatsApp (`infra/harness/fake-world.js`). Nothing real was contacted. Real-model quality and real-provider behaviour are **NOT TESTED**.

## Test totals (exact tree)
| Suite | Command | Result |
|---|---|---|
| Workflows unit tests | `cd services/workflows && npm test` | PASS 1300/1300, 0 skipped |
| Dashboard tests | `cd apps/dashboard && npx jest` | PASS 1150, 16 skipped (database-backed) |
| Dashboard database-backed tests (the 16) | `TRUST_DB_TEST=1 … npx jest lib/__tests__/trust-query.db.test.ts lib/__tests__/agent-health-query.db.test.ts` on scratch DB | PASS 16/16 |
| Lint | `npx next lint` | PASS, 0 warnings |
| Type check | `tsc --noEmit` (dashboard, workflows) | PASS, 0 errors each |
| Workspace build | `pnpm build` | PASS 6/6 |
| Harness flows | `infra/harness/run-flows.sh` | PASS 27 flows / 118 checks (after fix F-1; 117/118 before) |

## Flow list (all simulated-provider)
Held send, approve once, reject, edit-before-approve, provider failure recorded as failed, watching mode, paused team, cross-workspace approval attempt, auditor refused, revoked connection reported honestly, inbound customer message stored and answered, **inbound prompt-injection email attempt held and not sent (F13)**, approval card whose chat is gone after a restart, chat Allow is the approval, two simultaneous Allows send one email, two-approval refund rule, member refused refund, money-owed import/remind/isolation, chat asks who owes money (no contact details, nothing sent).

## Primary workflow: three scripted rehearsals (`reports/demo-rehearsal.js`)
Journey per run: owner asks a question in chat -> a send is held -> owner approves the exact action -> exactly one (simulated) send, row executed, two audit events -> approving again refused (409), no second send -> second send against a failing provider is reported as failed (not success), row `execution_failed`, no raw provider text -> another workspace cannot approve or see the row -> no unexpected pending rows.
| Run | Checks | Time |
|---|---|---|
| 1 | 14/14 | 2.3 s |
| 2 | 14/14 | 1.7 s |
| 3 | 14/14 | 1.7 s |
Differences between runs: none. Provider = LOCAL SIMULATION (labelled). Dashboard UI rendering of these states was not re-driven in a browser in this pass.

## Not tested
- Real model answers and tool choice (no keys): NOT TESTED.
- Real connectors (Gmail, WhatsApp, Shopify, Zendesk, Razorpay…): BLOCKED, no credentials; every connector is LOCAL SIMULATION or NOT TESTED.
- Workflows under a real Temporal server (restart mid-workflow, retries, backlog): NOT TESTED; no Temporal in the sandbox.
- Memory services (Cognee/Hindsight) were unreachable in this sandbox (the dashboard logged "keeping SQL memory"); memory behaviour beyond the SQL fallback is NOT TESTED.
- Ambiguous external success (provider acted, DarexAI timed out): not separately injected; F6 covers a clean provider failure only.
- Browser-level journey, accessibility scan, mobile layouts: not re-run in this pass.
