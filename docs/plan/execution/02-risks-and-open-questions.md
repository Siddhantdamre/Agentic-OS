# Execution — 02 Risks and open questions

Contradictions between current-working and future-scope, risks
that can make the plan fail, and gaps in the **source docs**
this plan could not close. Do not treat a guess in this file as
a product decision.

Linked from [../README.md](../README.md). Documentation only.

---

## 1. Contradictions (current-working wins on “what exists”)

Full absorb table: [../02-gap-analysis.md](../02-gap-analysis.md) §0.

| Future-scope still says | Current-working 2026-08-13 | Plan rule |
|-------------------------|----------------------------|-----------|
| Skills not mounted | Dockerfile COPY into `starter-skills` | Do not rebuild; R1 = land + rebuild image |
| Sandbox not in git | `infra/docker/sandbox/` in working tree | I2 = commit; do not redesign |
| Chatwoot ingest-only | `fireInboundAgent` after persist | Do not re-wire; O2 still missing |
| GBP/Meet/GA4/GSC/Chat/Cloud are stubs | Real HTTP executors + MCP names | C2 = UI hints only |
| Invite = insert row, no email | `org_invites` + copyable URL; Resend if key | B1 = make email default |
| Settings Meta URL points at Chatwoot | Distinct URLs | **Done** — not Phase 9 work |
| Inbox outbound fake `{success:true}` | Forwards to `/api/webhooks/outbound` | **Done** — H1 token still ops-blocked |
| Langfuse on shared Redis | Dedicated `langfuse-redis` | A1 = ClickHouse still flaky |
| Hermes route should be deleted | Route already gone | Do not list |
| `AGENTS.md` “49 tools” | **62** MCP tools | Cheat-sheet stale |
| Phase 9: fix Meta URL + inbox send | Already done | Do not re-list |

If future-scope and current-working disagree on **what to build
next**, future-scope wins (memory first, never skip Phase 6).

---

## 2. Stale companion docs (not future-scope)

- `BUILD_STATE.md` still has leftover “Next Phase 5” / Hermes
  wording in places. Current-working `16` is newer. Update
  BUILD_STATE on the next ship; this plan does not edit it.
- `packages/shared-types` is still a placeholder per
  current-working. Not a blocker for Phase 6; flag if packs
  need shared entity types.
- There is **no** `docs/README.md`. This plan did not create
  one (parent index did not exist). Root README “Key Docs”
  does not list `docs/plan/`.

---

## 3. Product risks

| Risk | Why it matters | Mitigation in this plan |
|------|----------------|-------------------------|
| Skip Phase 6 for a realtor demo | Theater; invented inventory | P3 blocked on M6 |
| Embed on the webhook thread | Misses 200-first; pool deadlock | M2 worker only |
| Second agent runtime | Hang class + tenancy holes | R6, L4 |
| Superuser `darex` in prod | RLS is theater | S1 immediate |
| In-process SSE | Second replica drops events | I3/H7 near |
| Pack without honest connectors | Logo wall | J5/J15 goldens |
| Licensed MLS never available | US RE blocked if we wait | Sheets wedge is the bar |
| Meta token / OAuth IDs never pasted | Executors stay dark | I1/C1/H1 parallel forever |
| Cross-org training from traces | Tenancy violation | B4 explicit ban |
| Chatwoot `?org_id=` query param | Conflicts with “never trust body org_id” | J4: move to inbox mapping |
| Computer-use as launch | Confirm-class hole | Phase 17 last resort |

---

## 4. Open product questions (need a human decision)

### Q1 — WorkItemWorkflow wrap vs replace

**Decided (code):** O2 wraps `AutonomousAgentWorkflow` as a child
(`WorkItemWorkflow.ts`). Do not replace the child.

### Q2 — E5 @employee mention-lock vs org-union allowlist

**Decided:** keep the org-union allowlist
(`docs/current-working/18-q2-mention-allowlist.md`).

### Q3 — `EMBEDDING_MODEL` not chosen

**Partial:** compose defaults `EMBEDDING_MODEL` to
`text-embedding-3-small`. App code still fail-fasts if unset in
prod worker. Do not hardcode a vendor in app source.

### Q4 — embed-worker queue: pg-boss vs Graphile vs Temporal

**Decided (code):** Temporal `EmbedWorkflow`. Do not add pg-boss
or Graphile.

### Q5 — Chatwoot org resolution

**Partial:** migration `018_channel_key.sql` adds
`chatwoot_inbox_map`. Prefer that map over leaked `?org_id=`.

### Q6 — Sandbox/skills vs commit `99b5f04`

Current-working `16` says the working tree may be ahead of
`99b5f04`. R1/I2 are “land what exists,” not “rewrite.” If
the tree and the doc disagree on a later date, current-working
wins.

---

## 5. Gaps in the SOURCE docs (plan could not invent)

These are missing from current-working **and** future-scope.
The plan flags them; it does not fill numbers or vendors.

| Gap | What is missing | What we did |
|-----|-----------------|-------------|
| Billing amounts / plan names | No prices, seat counts, or WhatsApp included-conversation quotas | B2 is “wire Stripe/Razorpay + meters”; marketing sets prices |
| Exact embedding model | No `text-embedding-*` name | Q3 — env only |
| Future-scope `06` status column | Not updated after GBP/Meet executors shipped | C2 + absorb note; do not treat `06` as live status |
| Eval #7 full text | Phase 6 mentions “eval #7 style” without the prompt | A2 stub + returning-contact; copy the eval when the source set is written |
| `packages/shared-types` purpose | Placeholder | Defer until P1 entities need shared TS |
| No `docs/README.md` | Docs folders unlisted | Plan lives at `docs/plan/`; no new parent index created |
| MLS / IN portal APIs | May never be licensable | Sheets wedge is the completeness bar for P3 |
| SuperTokens SAML details | Phase 15 says SSO; no IdP | S7 = test IdP; pick one at implementation time |
| Voice vendors | Phase 17 names Deepgram/Whisper as examples | Pull only; not a kernel choice |

---

## 6. Capacity / sequence risks

- One team: never skip Phase 6; skip Wave 4 first (future-scope
  `13`).
- Phase 10 connector spray without C3 registry recreates the
  catalog-hint lie.
- Phase 9 billing before S1 risks invoice queries as superuser.
- Insight (A3) before K4 recreates template theater.

---

## 7. How to close a question

Write the decision in a new `docs/current-working/` dated note
and change the matching work item DoD. Do not fork this plan
into a second architecture. Future-scope remains the target.

Related: [../02-gap-analysis.md](../02-gap-analysis.md),
[../04-principles-and-constraints.md](../04-principles-and-constraints.md).
