# Execution — 03 Build order

What unblocks what. Parallel tracks are marked. **Never** start
P3 (real estate) before M6.

Linked from [../README.md](../README.md) and
[../05-workstream-index.md](../05-workstream-index.md).
Documentation only.

---

## 1. Hard sequence (do not invert)

```
I1 migrate 009–011
  └─ S1 darex_app
       └─ M1 memory schema
            └─ M2 embed-worker (off webhook)
                 └─ M3 retrieveMemory
                      └─ R2 grounded prefix on all agent paths
                           ├─ M4 write-back
                           ├─ U1 citations
                           ├─ E2 router
                           └─ M5 /brain → U3
                                └─ M6 returning-contact eval
                                     └─ P1 packs → P2/U5 onboarding
                                          └─ P3 RE IN wedge (also needs C7, H1, Calendar)
```

Memory is the spine. Everything vertical hangs off M6.

---

## 2. Parallel from day one (does not wait on M1)

These can run while schema is designed:

| Track | Items | Unblocks |
|-------|-------|----------|
| Operator | C1 OAuth IDs, H1 Meta token, JINA key, Gmail re-connect | Live J1/J3/J5 |
| Land tree | R1 skills, I2 sandbox, C2 catalog hints, AGENTS.md 62 | Honest UI; R4 later |
| Eval stub | A2 Promptfoo skeleton | M6, pack goldens |
| Orchestration sketch | O1 tables (empty retrieve is fine) | O2 wrap |
| Research gate | L1–L5 | Stops a second runtime |

---

## 3. After M3 (near, still before packs)

```
R2 prefix
  ├─ O2 WorkItemWorkflow (decide wrap vs replace — Q1)
  │    └─ R3 session keys → O3/R5 → S2 webhook confirm
  ├─ K1–K3 ingest / cursors
  ├─ C3 registry → C4 split executor → C5/C6 Wave A/B
  ├─ I3 Redis bus → H7 two-replica SSE
  ├─ S4 redaction (should be in M2 path already)
  └─ K4 metrics → A3 insight → A4 cost cards
```

S1 should already be done. If not, do not put billing or
memory writes on superuser and call it shipped.

---

## 4. After M6 (mid)

```
P1 Core B2B pack
  └─ P2/U5 onboarding map
       ├─ B2/B3 billing (needs S1, S5)
       ├─ U6 mobile/a11y
       └─ P3 RE (needs C7 Sheets, H1 WhatsApp, E2, Calendar)
            ├─ U4 listings UI
            ├─ P4 US/PM/developer
            └─ P5 Wave 2 (two packs)

O2 mature
  └─ O4 Temporal plan-execute
       └─ O5 briefing / stale chase (needs I3, M4)
            └─ O6 playbooks + nurture
                 └─ O7 HITL + H5 owner WhatsApp + E3 critic
                      └─ U2 work-items UI
```

B1 invite email can land anytime after I1.

---

## 5. Complete / pull (after Phase 9 + 11 exits)

```
S3 audit_events
  └─ E6 auditor role + S7 SSO
       └─ S6 DSR
            └─ B5 marketplace preview (design)

P6 Wave 3–4     — RFC first; skip Wave 4 if capacity is one team
H4/H6 channels  — pull
Phase 17 voice / computer-use — last resort; R6 still holds
I7 split ingest — optional for the complete-OS label
```

---

## 6. Unblock matrix (short)

| If you want… | You must have first |
|--------------|---------------------|
| retrieveMemory on WhatsApp | M3 + R2 + H1 (token) |
| `/brain` | M3 + M5 |
| Phase 6 exit | M6 + two-org vector + honest disconnect |
| Registry UI | C3 (not more logos) |
| Two-replica inbox | I3 + H7 |
| Stranger signup exit | P2 + B2 + H1 + M3 |
| RE “2BHK” demo | M6 + C7 + H1 + P3 |
| Owner approve on WhatsApp | O7 + H5 (distinct number) |
| SSO auditor | S3 + E6 + S7 |
| Wave 4 clinic-ops | `12` compliance review; default no PHI |

---

## 7. Anti-patterns (sequence bugs)

1. RE pack before M6.
2. Insight cards before K4.
3. Wave E connectors before C3 + C2.
4. Billing before S1.
5. Embeddings inside the webhook handler.
6. Second MCP server or second employee loop for a vertical.
7. Marking pack-recommended connectors as connected.

Related: [../phases/00-phase-map.md](../phases/00-phase-map.md),
[../phases/01-phase-immediate.md](../phases/01-phase-immediate.md).
