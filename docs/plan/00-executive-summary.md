# 00 — Executive summary

This plan takes Darex from a **working AI-employee SaaS** (Phases 0–5
in code, snapshot 2026-08-13; **status audit 2026-08-14**) to the
**AI Brain Operating System** described in [`docs/future-scope/`](../future-scope/). It does not
propose a rewrite. The kernel stays: Next.js dashboard, Temporal,
atomic-agent, MCP bridge `mcp.darex.*`, Nango, LiteLLM, Postgres +
RLS + pgvector, SuperTokens, Langfuse.

Linked from [README.md](./README.md). Does not read or write
application data files.

---

## 1. What “complete” looks like

From [`docs/future-scope/00-vision-ai-brain-os.md`](../future-scope/00-vision-ai-brain-os.md)
§8, Darex is the Brain OS of a business when **all** of the following
are true for a newly onboarded org in a supported vertical:

1. They connect 3+ systems (for example WhatsApp + Gmail + CRM, or
   WhatsApp + Gmail + a Sheets inventory).
2. Inbound customer messages get a correct, **memory-grounded** reply
   without the owner in the loop, with honest fallback when a tool is
   disconnected.
3. Multi-step work (follow-up sequence, showing schedule, invoice
   chase) runs as a confirmed plan or a durable Temporal workflow, and
   survives process death.
4. The owner can ask “what do we know about this lead / listing /
   tenant?” and get **cited** memory + live system-of-record data,
   never invented facts.
5. Switching industry pack (agency → real estate) changes employees,
   entities, and workflows — not the runtime, tenancy, or connector
   plane.

Until then, Darex is a strong agent platform. That is the honest
label for today.

A pack is “live” only when it clears the quality bar in
[`docs/future-scope/03-industry-operating-system.md`](../future-scope/03-industry-operating-system.md)
§11: idempotent install, 3 employees, 5 golden conversations, honest
disconnected replies, 2 durable workflows, memory write-back on the
primary entity, a compliance validator that catches a known-bad
draft, and pack docs.

---

## 2. Why this sequence

[`docs/future-scope/01-from-today-to-os.md`](../future-scope/01-from-today-to-os.md)
§5 and [`13-phased-roadmap.md`](../future-scope/13-phased-roadmap.md)
are binding:

1. **Hygiene that unblocks everything** — operator migrations, OAuth
   client IDs, Meta token, skills/sandbox on the default branch,
   `darex_app`, catalog-hint lag. Several items that `01` still lists
   as holes (Chatwoot → agent, Meta settings URL, inbox outbound,
   mounted skills, real Google executors) are **already closed in the
   2026-08-13 working tree**. Do not rebuild them. See
   [02-gap-analysis.md](./02-gap-analysis.md) section 0.
2. **Memory and retrieval (Phase 6)** — otherwise every new vertical
   is another amnesiac demo. **Never skip Phase 6.**
3. **Connector registry + high-leverage connectors** — Salesforce or
   Zoho, DocuSign/Leegality, Google Business Profile, Maps. Finish
   Wave A before vanity logos.
4. **Event bus + scheduled workflows** — morning brief, stale-lead
   chase, Redis pub/sub so SSE works on more than one Node process.
5. **First vertical pack: real estate** (India wedge on
   WhatsApp + Gmail + Sheets, then US/PM/developer).
6. **Insight engine** using events + memory, not rule templates.
7. **More verticals as packs**, not as new apps.
8. **Enterprise:** SSO, residency design, Terraform, billing, audit
   role.

Skipping to “all integrations” or “ship the realtor demo” without
memory produces a directory of OAuth buttons and an agent that still
cannot remember the last showing.

---

## 3. What we keep (do not reopen)

From [`docs/future-scope/15-open-source-research-landscape.md`](../future-scope/15-open-source-research-landscape.md)
§1 and §14, and [`14-build-principles.md`](../future-scope/14-build-principles.md):

| Keep | Why |
|------|-----|
| Postgres + RLS + pgvector | Tenant SoR and memory in one database |
| Nango | OAuth / token plane. Never Composio. |
| Temporal | Durable workflows, HITL signals, timers |
| atomic-agent v0.1.72 | The only employee loop |
| MCP bridge `mcp.darex.*` | One action bus. No second server per vertical. |
| LiteLLM | JSON classify / plan / revise / embed. Not the tool loop. |
| Langfuse | Traces. Fix ops; do not swap for LangSmith. |
| SuperTokens | Sessions. Add SAML on top. |
| Redis | Split instances (bus / Langfuse / cache), do not replace |
| Chatwoot | Thin gateway (`apps/inbox`). Do not fork the product. |
| Next.js dashboard | Owner UI + API. Split ingest/SSE off over time. |
| Jina | World search/extract. Cite; never inventory. |
| Docker sandbox | `code_execution`. Keep the pattern. |
| Plan-confirm-execute | Irreversible-action protocol forever |
| Employees as config | New role = YAML, not a kernel change |

**Reject as kernel:** LangGraph, Hermes, Letta, Mastra, CrewAI,
Mem0/Zep Cloud as tenant memory, a new OAuth broker, our own MLS,
escrow, custom foundation model, scraping listing portals, awaiting
embeddings inside webhooks, trusting `org_id` from a request body.

---

## 4. Success definition for this plan

This plan is complete when:

- Phases 6–9 and 10 (Wave A/B) and 11 (RE brokerage IN wedge) have
  testable exit criteria recorded as shipped in current-working.
- The five Brain OS tests in section 1 pass for Core B2B and for
  `real-estate-brokerage` on a Sheets + WhatsApp + Gmail org.
- Every journey in
  [execution/00-end-to-end-journeys.md](./execution/00-end-to-end-journeys.md)
  has a verification note (probe, eval, or live E2E) and never
  fabricates connector or inventory data.
- Remaining work (Phases 12–18, Wave 3–5 packs) is scheduled as
  pull, not as a second product.

“Complete OS” in
[phases/04-phase-complete.md](./phases/04-phase-complete.md) is that
bar plus enterprise SSO/audit and two Wave 2 packs. It is **not**
every P3 row in the integrations catalog.

---

## 5. Recommended next five build items

The original “first five” (migrate 009–011, land sandbox/skills,
Phase 6 schema, retrieveMemory prefix, eval stub) are **in the
tree**. Do not rebuild them. Remaining first five:

1. **Operator hygiene** — real OAuth client IDs in Nango UI `:3003`,
   rotate `META_ACCESS_TOKEN`, re-connect Gmail for `gmail.compose`,
   set `JINA_API_KEY`. No product code.
2. **Wire inbound memory** — **done**: `retrieveMemoryActivity` calls `retrieveMemory`.
   Remaining: run `check-phase6-memory.js` + returning-contact eval on a migrated DB.
3. **WorkItem HITL wait** — **done**: `condition()` on approve/reject **before**
   webhook `send`/`pay`/`sign` tools (PlanExecute already waits). Conversation
   flips to `needs_attention` while waiting. M6 live eval on a migrated DB is
   still a leftover.
4. **RE pack live-verify** — `packs/re-brokerage-in` goldens; showing
   books on Calendar when connected; never invent inventory.
5. **One go-live surface** — Gmail Pub/Sub **or** public widget
   embed JS **or** Darex Stripe/Razorpay keys — pick one, don’t spray.

---

## 6. How the rest of this folder is used

| If you need… | Open |
|--------------|------|
| What exists today | [01-current-state-baseline.md](./01-current-state-baseline.md) |
| Done / partial / missing | [02-gap-analysis.md](./02-gap-analysis.md) |
| End-state boxes and new services | [03-target-architecture.md](./03-target-architecture.md) |
| Rules you must not break | [04-principles-and-constraints.md](./04-principles-and-constraints.md) |
| Which file owns a gap | [05-workstream-index.md](./05-workstream-index.md) |
| A build task with repo path | The matching `workstreams/*.md` |
| This quarter vs next | `phases/01` through `04` |
| A journey to demo | [execution/00-end-to-end-journeys.md](./execution/00-end-to-end-journeys.md) |
| Whether a task is done | [execution/01-definition-of-done.md](./execution/01-definition-of-done.md) |
| A contradiction or open question | [execution/02-risks-and-open-questions.md](./execution/02-risks-and-open-questions.md) |
