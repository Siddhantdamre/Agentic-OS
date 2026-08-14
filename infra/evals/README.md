# Darex Phase 6 evals (A2 / M6 / R4)

Offline goldens. They do **not** sit on the Ask AI request path. The Node
runner is the source of truth; Promptfoo YAML is the ADOPT shape.

## What is covered

| Golden | File | Asserts |
|--------|------|---------|
| Empty org does not invent memory | `empty-org.yaml` | Live `retrieveMemory` on a new org → `no stored memory`. Kapoor / 3BHK / Andheri must not appear. Invented prose **fails** the golden. |
| Returning contact (M6) | `phase6-returning-contact.yaml` | Seed known WhatsApp `+14155550100` → `retrieveMemory` must return Priya Kapoor + last issue. Empty retrieve **fails**. Inventing a different prior fact fails. |
| Disconnected Sheets / MLS | `disconnected-sheets-mls.yaml` | `status:error`, `connected:false`, `setupUrl:/connectors`. Invented listing ids fail. |
| Honesty triad | `honesty-connectors.yaml` | never-configured / revoked / connected. Includes Wave B leftovers (Zoho CRM, Leegality, QuickBooks). Connected **skips** unless `EVAL_CONNECTED_FIXTURE` is a recorded provider payload. `{success:true}` without a provider call fails. |
| Skill playbook on vs off (R4) | `skill-playbook.yaml` | `gmail-playbook` ON includes draft-before-send; OFF does not. ON + disconnected Gmail still `notConnected`. |
| RE brokerage (P3 / 05 §11) | `re-brokerage.yaml` | Fixture matcher: 2BHK Koramangala under 1.2 Cr returns **only** sheet ids. Extra ids fail. Zero matches empty. Fair housing / RERA blocked. “I paid” does not close. `*-live` seeds `re_listings` + RLS (skip only if DB unreachable; missing `015_packs.sql` fails). |

Returning-contact and empty-org **skip only if Postgres is unreachable** (honest
message). Missing `013_memory_rag.sql` or a broken `retrieveMemory` **fails**.

## Commands

```bash
bash infra/scripts/run-evals.sh
node infra/evals/runner.js
node infra/evals/runner.js re-brokerage.yaml   # P3 pack goldens only
node infra/scripts/check-phase6-memory.js
node infra/evals/seed-returning-contact.js
node infra/evals/lib/parse-yaml.js   # parser self-check
```

Compile retrieve before live memory goldens:

```bash
pnpm --filter @darex/workflows exec tsc
```

Fail-closed when `013_memory_rag.sql` (M1) is not applied:

```
[FAIL] M1 not applied — missing tables: org_memory, ...
```

`check-phase6-memory.js` may honest-skip **only** that probe with
`EVAL_ALLOW_MISSING_MEMORY=1`. The YAML returning-contact golden still
fails if tables are missing.

Optional Promptfoo:

```bash
EVAL_RUN_PROMPTFOO=1 bash infra/scripts/run-evals.sh
```

Connected honesty skips unless `EVAL_CONNECTED_FIXTURE` points at a recorded
provider payload with `providerRecorded: true` or `httpStatus`. Copy-paste
`{success:true}` is refused. Do not add a fake `connected-recorded.json`.

## Fixture seeder

`seed-returning-contact.js` inserts a synthetic org + `entity_memory` row
(Priya Kapoor / 3BHK Andheri / leaky tap). The eval runner seeds, calls
`retrieveMemory`, then deletes the org. `EVAL_KEEP_FIXTURE=1` keeps it for
manual inspection.

## Non-goals

- No LangGraph / Mem0 / CrewAI / Composio.
- No eval traffic through `POST /api/ask-ai`.
- No handwritten `{success:true}` counted as a connected pass.
