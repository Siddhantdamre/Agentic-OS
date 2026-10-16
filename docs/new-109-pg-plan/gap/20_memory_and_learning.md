# 20 — Memory & Learning: How an Employee Knows and Improves

> **The gap this closes.** `19 §1` step 2 says "retrieve the facts needed to
> act" and stops there. Retrieval is where an autonomous employee is most
> different from an interactive assistant: **nobody is there to supply the
> context.** An assistant can be vague and be corrected in the next message. An
> employee acting at 3am on what it retrieved has one shot.
>
> The good news, verified in the repo: the memory layer is largely built.
> `013_memory_rag.sql` ships four scoped stores plus a typed edge table,
> `022_entity_graph.sql` adds contradictable facts, and `memory/retrieve.ts`
> already does hybrid vector + full-text retrieval with citations. **This file
> is mostly about using it correctly, not building it.**

---

## 1. What Already Exists

| Store | Scope | Holds | Analogue |
| :-- | :-- | :-- | :-- |
| `org_memory` | Org | SOPs, brand, FAQs, policy | Institutional knowledge |
| `employee_memory` | One employee | Role-specific learned procedure | Job-specific skill |
| `entity_memory` | One customer/account/asset | The history of this relationship | Who you know |
| `conversation_memory` | One thread | Rolling summary | Short-term recall |
| `memory_edges` | Cross-store | Typed relations, weighted | Association |
| `facts` + `fact_conflicts` (`022`) | Org | Typed, comparable, **contradictable** claims | Things known to be true — and disputes about them |

Plus `org_playbook_promotions` (`020`) — a plan a human named and promoted to a
reusable org procedure, `org.*`-prefixed and uniquely keyed per org. That table
is the repo's existing answer to procedural learning, and §5 builds on it
rather than inventing a parallel mechanism.

**Nothing new is needed for Phase 1–4.** The work is retrieval discipline,
write-back discipline, and using `facts`/`fact_conflicts` where the entity
graph is stronger than prose.

---

## 2. Retrieval, Per Employee

The three employees need different things, and a shared "retrieve everything"
call is how they all end up mediocre.

| Employee | Reads first | Then | Never |
| :-- | :-- | :-- | :-- |
| **Customer** | `conversation_memory` (this thread), `entity_memory` (this customer) | `org_memory` for policy (refunds, SLAs) | Other customers' entity memory |
| **Operations** | `facts` (typed state), `org_memory` (SOPs) | `entity_memory` for the object at hand | Conversation prose — it needs state, not narrative |
| **Growth** | `entity_memory` across won accounts (the ICP), `facts` | `org_memory` for positioning | Individual conversation transcripts |

Three rules that matter more than the table:

**1. Retrieve for the frame, not for the message.** `19 §1` produces a typed
frame. Query on *that* — the customer, the promise, the object. Embedding the
raw inbound message retrieves whatever is textually similar, which on a message
like "any update?" is nothing useful.

**2. The token budget is a correctness control, not a cost control.**
`retrieve.ts` already clamps it. Wide retrieval measurably degrades autonomous
decisions: more retrieved context means more surface for the model to build a
confident, wrong synthesis across unrelated threads. Prefer 5 highly relevant
citations to 40 plausible ones.

**3. Citations are load-bearing.** `retrieve.ts` returns them; the grounding
term in `13 §5` consumes them. An autonomous action asserting something with
no citation should score low and therefore ask. This is the mechanism that
makes a poorly-documented org's employee *appropriately* cautious rather than
confidently wrong.

### Structured before prose

Where `022`'s `facts` can answer, use it instead of vector search. "What is
this account's payment term?" is a fact lookup — exact, comparable, and
carrying its own contradiction record. Retrieving three prose snippets that
each mention a different payment term and asking a model to pick is strictly
worse, and it is what happens by default.

Prose is the fallback for what is not yet modelled, and it stays the evidence
behind facts via `facts.evidence_memory_id`.

---

## 3. Write-Back Discipline

An employee that never writes back relearns the same thing forever. One that
writes back indiscriminately poisons its own retrieval within weeks — and
poisoned memory is far harder to notice than an empty one, because everything
keeps working while slowly getting worse.

**Write back only:**

| Event | Store | Why |
| :-- | :-- | :-- |
| A human corrected the employee | `employee_memory` | The highest-signal event available. Never lose one. |
| A decision card was resolved | `entity_memory` | The precedent term in `13 §5` |
| A conversation closed | `conversation_memory` | Summary; the thread is now history |
| A durable fact was established | `facts` (`022`) | Typed and contradictable |
| An obligation was resolved | `entity_memory` | "This customer's issues take ~3 days" |

**Never write back:** the employee's own reasoning, plans that were not
executed, retrieved content (that is a copy, not a memory), or anything a model
generated that no human or system confirmed. The last one is the trap —
writing generated summaries back into a retrieval store is how a system starts
citing itself, and every iteration drifts a little further from what actually
happened.

### Contradiction goes to `fact_conflicts`, not to the newest write

`022` already models this: two current facts disagreeing creates a
`fact_conflicts` row that joins the human queue via `work_item_id`. Resolution
strategies are `recency | trust | human | both_valid`.

Do **not** default to "newest wins." A customer saying "our address is X" does
not override a signed contract saying Y — that is `trust`, not `recency`. And
`both_valid` is real: a customer legitimately has a billing address and a
delivery address, and collapsing them loses information.

Where the conflict changes what the employee would *do*, route it to a human
via the existing `work_item_id` link — no new escalation mechanism, per `022`'s
own comment.

---

## 4. Memory Is Multi-Tenant PII

Everything in `18 §3` applies here with more force, because memory is where
customer content actually accumulates:

- All four stores are org-scoped with RLS. `entity_memory` additionally must
  never be retrieved across customers within an org for the Customer Employee
  — a correct RLS policy does not stop cross-*customer* leakage inside one
  tenant. That constraint lives in the query.
- **DSR erasure reaches all four stores plus `facts`.** `18 §3` lists
  `agent_open_loops.source_quote` and `context_payload`; memory is the larger
  surface and easier to forget because it is not new code.
- `expires_at` exists on these tables. Use it for anything ingested from a
  transient source rather than accumulating forever.

---

## 5. Procedural Learning — Use the Table That Exists

`org_playbook_promotions` is the mechanism: a plan a human named and promoted,
stored as `steps` JSONB, `org.*`-prefixed, unique per org.

The autonomous extension is small and deliberately human-gated:

```text
  employee resolves the same shape of problem N times, same steps,
  no human correction
        │
        ▼
  propose a playbook  ──►  a decision card (17 §2), not an auto-write
        │                  "I've handled this 6 times the same way.
        ▼                   Make it a standard procedure?"
  human names it     ──►  org_playbook_promotions
        │                  (named_by_user_id is NOT NULL — by design)
        ▼
  future triggers of that shape skip planning: the steps are known
```

Two properties worth defending:

- **Promotion requires a human name.** The schema enforces it —
  `named_by_user_id` is `NOT NULL REFERENCES users(id) ON DELETE RESTRICT`,
  and the name must be 3–80 characters. That is not incidental: a procedure
  nobody named is a procedure nobody owns, and an org cannot audit what it
  cannot refer to.
- **A promoted playbook still passes the gate.** Skipping planning is not
  skipping policy. `15 §2` runs on every step regardless of provenance.

This is also the highest-value autonomy improvement available: a matched
playbook means step 4 of `19 §1` becomes a lookup, which is cheaper, faster,
deterministic, and — because a human approved the shape — more trusted.

---

## 6. The Three Learning Loops, Ranked

| Loop | Signal | Writes to | Speed | Value |
| :-- | :-- | :-- | :-- | :-- |
| **Correction** | A human fixed the employee's output | `employee_memory` | Immediate | **Highest.** Rare and unambiguous. |
| **Precedent** | Approvals and rejections of cards | `entity_memory`, `13 §5` precedent term | Days | High. Feeds confidence directly. |
| **Preference** | Rejection reasons (`17 §3`) | `agent_preference_suppressions` | Weeks | Medium, and the easiest to over-fit (`11 §7`) |

**Corrections are the scarcest and most valuable signal in the system.** A
human bothering to fix something is telling you precisely where the employee is
wrong, in the exact context where it is wrong. Capture every one. An employee
that repeats a mistake it was already corrected on is the fastest way to lose
an owner's trust — faster than never having learned it at all, because it
reads as not listening.

**No loop retrains a model.** All three write to retrieval and policy stores.
Fine-tuning is out of scope for this plan: it is slow, it is hard to audit
against `18 §5`, and it cannot be undone for one org without affecting others.

---

## 7. Failure Modes

| Failure | Signature | Countermeasure |
| :-- | :-- | :-- |
| **Self-citation drift** | Employee cites its own generated summaries as fact | Never write generated content back (§3) |
| **Stale confidence** | High confidence from precedent that no longer applies | Decay precedent; recompute on contradiction |
| **Retrieval bloat** | Every query returns 40 chunks; quality drops | Enforce the token budget (§2) |
| **Cross-customer leakage** | Entity memory from customer A informs an action for B | Constrain in the query, not only in RLS |
| **Empty-memory overconfidence** | New org, no memory, employee acts anyway | Grounding term floors confidence (`13 §5`) |
| **Playbook rot** | A promoted procedure outlives the process it encoded | Track per-playbook outcome; surface stale ones in settings |

The first is the one that compounds. Everything continues to work while the
system's picture of the world slowly detaches from reality, and by the time it
is visible the store is full of citations pointing at other citations. The
guard is a single rule applied without exception: **generated content is never
a memory.**

---

## 8. What to Build (small, because most exists)

| Ticket | Work | Size |
| :-- | :-- | :-- |
| `P2-MEM-1` | Employee-scoped retrieval wrappers over `retrieve.ts` (§2) | S |
| `P2-MEM-2` | Write-back policy in one module — the allowlist from §3 | M |
| `P3-MEM-3` | Route `fact_conflicts` with action impact to `work_items` | S |
| `P4-MEM-4` | ICP built from `entity_memory` across won accounts (`P4-ICP-1`) | M |
| `P5-MEM-5` | Playbook proposal card + promotion flow (§5) | M |
| — | DSR erasure extended to all memory stores (`18 §3`) | S |

No new tables. If a ticket here proposes one, check `013`, `020`, and `022`
first — the odds are it already exists under a name from a different vocabulary.
