# DarexAI — Full Technical & Strategic Context

**Last updated:** 17 Aug 2026
**Repo root:** `C:\Users\siddh\Downloads\darex-new\Agentic-Os-SaaS-main`
**Git state:** nothing committed — all work below is live locally only

> Two earlier copies of this repo exist at `darex-main` and
> `Agentic-Os-SaaS-feat-atomic-agent-integration`. **Both are stale.** All work
> described here is in `darex-new\Agentic-Os-SaaS-main`.

---

## 1. Purpose

This document captures the entire current state of the DarexAI project so that
the next session, a new engineer, or a board member can understand:

- What product is being built
- What has been proven
- What has been fixed
- What remains open
- What decisions are needed
- What the next execution prompt should be

---

## 2. Strategic Product Context

The original idea evolved from "DPDP compliance SaaS" into something bigger and
more defensible.

### Current thesis

> **DarexAI is the authorization layer for autonomous software.**
> **AI can decide what to do. Dare decides whether it is allowed to act.**

### Product phases

| Phase | Name | Purpose |
|-------|------|---------|
| 0 | Provable AI data erasure | Show deletion across CRM, transcripts, embeddings, vector DB, agent memory |
| 1 | DPDP Guardian | Consent, PII redaction, retention, erasure, audit evidence |
| 2 | AI Data Guardian | Control what AI can see, remember, and transmit |
| 3 | AgentGuard | Control what AI agents can do |
| 4 | Human AI Control Plane | Cross-stack enterprise policy layer |

### Competitive honesty

The board pitch does **not** claim "nobody is doing this."

Known players:

- Microsoft Agent 365 — governance inside Microsoft
- Cloudflare — MCP/network layer
- Privy by IDfy — DPDP/privacy workflows
- AIRGuard, ToolGuardian — research systems
- OneTrust, Securiti — enterprise GRC

DarexAI's intended position:

> **Vendor-neutral, data-rights-native, cross-stack runtime enforcement.**

---

## 3. Current Technical State

### What works from a clean state

| Check | Result |
|-------|--------|
| Clean rebuild with `--no-cache` for Darex services | PASS |
| Migrations on empty DB | PASS — **25 applied** (024 was the count before migration 025 was added) |
| Containers healthy | PASS — 19–20 |
| Phase 0 | PASS — 20/20 |
| Inbound E2E | PASS — 8/8 |
| Agent reply E2E | PASS — 8/8 |
| Unit tests | PASS — **171/171** |
| Task completion on seeded knowledge | PASS — 100% |
| Output quality harness | PASS — built, 17/17 self-tests |
| Security controls | PASS — 2/2 |
| DOCX ingestion end-to-end | PASS |
| PDF ingestion end-to-end | PASS (after `unpdf` swap) |
| Tenant isolation | PASS — 6/6 incl. cross-tenant regression |
| LLM failover | PASS — 5/5, three tiers answer independently |

### Ingestion support matrix

| Source | Status |
|---|---|
| File upload — PDF | **Proven end-to-end** (`unpdf`) |
| File upload — DOCX | **Proven end-to-end** (`mammoth`) |
| File upload — txt/md/csv/tsv/json/yaml/html | Supported |
| Scanned PDF | Refused with a specific "no text layer" message |
| Legacy `.doc` | Refused with "save as .docx first" |
| Google Drive | Implemented, **untested** — needs OAuth |
| Google Sheets | Implemented, **untested** — needs OAuth |
| HubSpot | Implemented, **untested** — needs OAuth |
| Notion | **Not implemented** — deferred, unsupported for launch |
| Email | **Not implemented** — deferred, unsupported for launch |
| Chatwoot conversations | Separate `MemoryWriteBackWorkflow`, unverified |

> **Important:** ingestion writes to `org_memory` with a **NULL embedding** when
> `EMBEDDING_MODEL` is empty. Retrieval ranks on full-text (`body_tsv`) and only
> *adds* vector similarity when an embedding exists. Embeddings are an
> enhancement, not a prerequisite. This is why the stack works today with no
> embedding provider configured.

---

## 4. Critical Bugs Found & Fixed

| Bug | Impact | Status |
|------|--------|--------|
| Orgs stuck in `provisioning` | New tenants could not receive inbound messages | Fixed + migration 024 |
| `CHATWOOT_WEBHOOK_SECRET` blanked by compose | All webhooks 401 | Fixed |
| Fake LLM failover: all 3 fallbacks same model | Exhausted key = total outage | Fixed |
| IPv6 `localhost` causing ECONNRESET | Deterministic "flaky" failures | Fixed across 11 scripts + migrate.js |
| LiteLLM key never reaching worker | Agent died at config | Fixed |
| Embeddings starvation | 44s retries exhausted worker, no replies | Fixed |
| `EMBEDDING_MODEL=` treated as fatal | Worker crash-loop | Fixed |
| `inbox_map` silently overriding authenticated org routing | Cross-tenant misrouting | Fixed + loud conflict warning |
| Failed per-org auth falling through to inbox_map | Wrote into a **third** org | Fixed — now 400, writes nothing |
| Prompt injection disclosure | Internal operating instructions leaked | Fixed |
| Internal `org_id` leak into customer reply | Internal UUID shown to customer | Fixed |
| Critic gate bypass | Raw ungated reply persisted before critic/sanitiser | Fixed |
| **Blind retrieval** | `plainto_tsquery` ANDs all terms; natural questions matched nothing | **Fixed — OR-tsquery + ranking. This took completion 29% → 100%** |
| Memory not counted as grounding evidence | Correct memory-sourced answers would be blocked | Fixed |
| Silence on agent/provider failure | Customer got no reply at all | Fixed — fallback ack + gap capture |
| Silence on HITL hold | Unbounded wait, customer never heard back | Fixed — 2-min bounded wait |
| Silence on grounding block | Blocked draft saved no message | Fixed — neutral ack, draft still withheld |
| HITL over-trigger on inbound questions | "Do you charge for installation?" parked as a payment | Fixed |
| Post-reply gate gagging agent's own research | Tool-output text like "delivery charge" triggered payment hold | Fixed — classify on tool identity, never output |
| Third-party PII refused for wrong reason | Declined on connector availability, not privacy | Fixed — deterministic pre-agent privacy refusal |
| 900-char markdown to WhatsApp | Renders as literal `**` and `-` | Fixed — channel-aware formatter, 400 char |
| Grounding blocking valid calendar inference | `viewing_slot` intermittent | Fixed narrowly — see §5 |
| PDF parser failure | `pdf-parse@1.1.1` cannot read modern PDFs | Fixed — replaced with `unpdf` |
| Harness false positives/negatives | Scorer passed injection, failed correct refusals | Rewritten with named assertions |
| Harness 2500ms poll inflating latency | Every latency number quantised/inflated up to 2.5s | Fixed — 400ms poll |

### One recurring root cause worth naming

**Three separate bugs were the same mistake: a matcher built for one kind of
input, applied to another.**

- `plainto_tsquery` — ANDed question terms against documents
- `isPayRisk` — tool identifiers matched against a customer's English
- `blobOf` — folded tool *output* in with tool *identity*

Each one compiled, looked correct, and silently did the wrong thing. **The
highest-value remaining code review is auditing every regex in the reply and
routing path against what it actually receives** — test-first, from real
strings.

---

## 5. Grounding fix — `viewing_slot`

Diagnosed from a recorded `critic_blocked` event, not from a hypothesis:

```json
{"reason":"only 33% of factual claims are supported by retrieved evidence",
 "violations":["date:22 Aug","number:2026"]}
```

Asked *"Can we book a viewing for Saturday morning?"*, the agent answered
correctly from the knowledge base **and helpfully resolved which Saturday**. No
document will ever contain next Saturday's date, so the gate demanded evidence
that cannot exist.

**Fix is deliberately narrow** (this is the fabrication guard):

- a **date** is exempt only when the evidence itself names the weekday resolved
- a bare 4-digit **year** is exempt only in a temporal context
- money, percentages, quantities and identifiers are **untouched**

8 regression tests prove correct multi-fact answers pass while invented prices,
percentages, quantities, unsupported dates, and "2026 units in stock" (a
quantity dressed as a year) are all still blocked. **`viewing_slot` went from
4/5 to 4/4.**

---

## 6. Latest Reliability Result — Not Fully Green

Reliability ×20 stopped at **run 4** on a **quality** failure, not a completion
failure. Completion was **100% on every run**.

```
run 1/20  ok    completion 100%  quality 12 clean
run 2/20  ok    completion 100%  quality 12 clean
run 3/20  ok    completion 100%  quality 12 clean
run 4/20  FAIL  ctrl_unknowable: QUALITY — no_internal_terms
```

Per-case: **every case 4/4**, including `viewing_slot` and both security
controls.

The failing reply:

> "The revenue metric for the last financial year (April 2025 – March 2026)
> shows ₹0 collected via Stripe. This metric only tracks Stripe payments logged
> in your **channel data**, so it may not capture all revenue sources. Would you
> like me to check other **payment connectors** (Razorpay, QuickBooks invoices)
> or **query the database** directly for a broader revenue picture?"

The prompt rule against mechanism leakage exists and is usually obeyed — it
slipped once in four runs.

**Conclusion:** prompt-level suppression is guidance, not a control. This needs
a deterministic backstop in `sanitiseCustomerReply`, exactly like the `org_id`
leak and injection-disclosure fixes.

---

## 7. Remaining Work

| # | Task | Status |
|---|------|--------|
| 1 | Deterministic backstop stripping internal system names from replies | Not done |
| 2 | Rerun reliability ×20 after backstop | Not done |
| 3 | Streaming latency test (10+ agent-sized streaming requests) | Not done |
| 4 | Paid LLM key decision | **Waiting on you** |
| 5 | Final 15-case quality suite using ingested knowledge | Not done |
| 6 | Learn from operator reply edits | Not built |
| 7 | Verify Drive/Sheets/HubSpot end-to-end | **Waiting on OAuth** |
| 8 | Notion and email ingestion | Deferred — unsupported for launch |
| 9 | Publish `atomic-agent` to GHCR | **Waiting on PAT** — hard deploy blocker |
| 10 | Backup/restore, rollback, monitoring, docs, load test | Phase 2, not started |
| 11 | Git commit | **Nothing committed** |

### Known open risks not yet addressed

- **Provider 502s.** Free-tier Nvidia returns `502 provider_unavailable` on
  streaming calls under load. The never-silent fallback stops the silence but
  does not get the answer. Unmeasured — this is what step 3 is for.
- **`atomic-agent` cannot be built from source.** `ECONNRESET` compiling
  `better-sqlite3`, reproduced 3×. The running container was built before this
  broke and exists **only on this machine**. The stack cannot currently be
  deployed to a new server.

---

## 8. Decisions Required From You

1. **LLM key** — free-tier streaming is unreliable. A paid key with headroom is
   likely needed before latency can be measured meaningfully.
2. **OAuth accounts** for Drive / Sheets / HubSpot — code exists, testing needs
   real authorized accounts.
3. **Notion / Email** — currently unsupported. Build for launch, or ship without?
4. **Registry credentials** — GitHub PAT with `write:packages` to publish
   `atomic-agent` to GHCR. **This is the single hard deploy blocker.**
5. **Git commit** — everything is uncommitted and live locally. This is the
   biggest operational risk in the project: a disk failure loses a full session
   of fixes.
6. **Migration 025** — applied locally; must be committed with the codebase or
   rolled back.

---

## 9. Important Files and State

> **Corrected.** An earlier version of this document listed paths under
> `apps/worker/` — **that directory does not exist in this repo.** The worker
> code lives under `services/workflows/`.

### Agent runtime — `services/workflows/src/`

| Path | Role |
|---|---|
| `workflows/WorkItemWorkflow.ts` | Inbound orchestration; retrieval, HITL gates, critic, sanitiser, reply |
| `reply-gate.ts` | Sanitiser, privacy refusal, channel formatter, knowledge-gap detector, fallback replies |
| `grounding.ts` | Claim extraction + verification, calendar-inference exemption |
| `memory/retrieve.ts` | OR-tsquery full-text + optional vector retrieval |
| `atomic-agent-client.ts` | Prompt construction — confidentiality, privacy, format, quality rules |
| `activities/embed.ts` | Ingestion → `org_memory`; NULL-embedding path |
| `activities/index.ts` | Activity registry incl. `recordKnowledgeGapActivity` |
| `activities/ingest-file.ts` | `ingestFileActivity`, `syncConnectorActivity` |
| `inbound-hitl.ts` | Send/pay/sign classification |

### Dashboard — `apps/dashboard/`

| Path | Role |
|---|---|
| `app/api/brain/upload/route.ts` | **Upload endpoint** (PDF/DOCX/text) |
| `app/api/brain/reindex/route.ts` | Connector sync + single-doc ingest trigger |
| `app/api/webhooks/chatwoot/route.ts` | Inbound webhook, org resolution precedence |
| `lib/inbound-agent.ts` | Agent dispatch from webhook |
| `lib/db.ts` | Scoped client, org creation |
| `next.config.js` | `serverComponentsExternalPackages: ['unpdf','mammoth']` |

### Test & harness scripts — `infra/scripts/`

| Path | Role |
|---|---|
| `completion-suite.js` | Task completion + quality, seeded knowledge |
| `quality-rules.js` | 9 output-quality rules **+ its own self-test** (`node infra/scripts/quality-rules.js`) |
| `reliability-completion.js` | Reliability ×N over the full completion suite; stops on first failure |
| `harden-suite.js` | Quality / failover / isolation / reliability |
| `check-upload-e2e.js` | Upload → agent, plain text |
| `check-upload-formats.js` | PDF + DOCX → agent |
| `latency-probe.js` | 3-layer latency attribution |
| `.harden-state/` | All run results, incl. `reliability-completion.json` |

### Regression tests — `services/workflows/src/*.test.ts`

`reply-sanitiser`, `reply-format`, `knowledge-gap`, `hitl-pricing`,
`hitl-tool-blob`, `grounding-calendar` — run with:

```bash
node --test services/workflows/dist/*.test.js
```

### Database

- Migration **025** = `knowledge_gaps` table + `record_knowledge_gap()` +
  `resolve_knowledge_gap()` — the self-learning loop.

---

## 10. A note on working method

Several hours were lost this session to a repeated pattern worth avoiding:

1. **Guessing before reading logs.** The PDF failure took four cycles; the
   answer (`bad XRef entry`) was in the container log the whole time. The
   `viewing_slot` cause was already recorded in `work_events`.
2. **Shell string-surgery on regex-heavy code.** Heredocs silently collapsed
   `\s` → `s` and turned `\b` into a literal backspace byte. The patterns still
   compiled and silently stopped matching. **Use file tools, never sed/heredoc,
   on regex code.**
3. **Changing two variables at once.** The `unpdf` fix landed in one step
   because the library was verified against the real fixture *before* wiring.

---

## 11. Next Session Prompt

```text
Continue from current state. Do not redo completed work.

1. Add deterministic customer-reply sanitization for internal system names:
   - Fix the ctrl_unknowable reliability failure.
   - Strip or redact internal system names like Stripe, Razorpay, QuickBooks,
     database, connector names from customer replies.
   - Keep the reply useful: do not remove necessary information like refund
     policy or invoice status.
   - Add regression tests from the exact failing reply and from normal answers
     containing payment terms that should remain.

2. Rerun reliability ×20:
   - Full completion suite, 20 runs.
   - Stop on first real failure.
   - viewing_slot must remain stable.
   - Report pass/fail count.

3. Run streaming latency test:
   - At least 10 agent-sized streaming requests.
   - Report provider/model, p50, p95, failure rate.
   - If p95 > 30s, stop and report. Do not mask with timeout increases.

4. Only after reliability and latency pass:
   - Rerun the full 15-case output quality suite using ingested knowledge.
   - Report the final quality table.

5. If all above pass and you still have capacity:
   - Add self-learning from operator reply edits.
   - Capture corrected replies as high-priority learned knowledge.
   - Never allow security refusals or fabricated answers to become learned
     knowledge.

Do not commit to git without my explicit approval.
```

---

## 12. Board-Ready One-Liner

> **The core engine now works from a clean state, answers from real ingested
> documents (PDF and DOCX proven end-to-end), refuses fabrication, and survives
> the failure modes that kill most AI-agent products.**
>
> Remaining work is operational readiness: provider reliability, final output
> polish, backups, monitoring, docs, and registry/deployment hardening.

**Caveat for the board, stated plainly:** the system cannot currently be
deployed to a new machine — `atomic-agent` fails to build from source and has
not been published to a registry. Everything above is proven on one developer
machine, and nothing is committed to version control.
