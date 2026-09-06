# 21 — Design Spec: Entity Graph and Fact Model

> Status: **specification, not built.** This is `09` Tier 1.1 — the hinge the
> rest of the brain depends on. Written to be implementable without further
> design work.

---

## 1. Problem statement

Darex remembers **text**. `entity_memory` keys prose chunks by
`(entity_type, entity_id)`, and retrieval returns snippets a model turns into a
paragraph. Three consequences:

1. **"What's the status of X?" is a generation, not a lookup.** Two conflicting
   chunks both retrieve, and the model silently averages them into one confident
   sentence. There is no mechanism by which the system could know it did that.
2. **Nothing can be watched.** A watcher needs a comparable value with a due
   date. Prose has neither.
3. **Nothing can be corrected.** A user who spots a wrong fact has nowhere to
   put the correction; the next retrieval returns the same wrong chunk.

The fix is not "better RAG". It is storing **typed, comparable, contradictable
facts** alongside the prose, with the prose kept as evidence.

---

## 2. Design constraints

Inherited, non-negotiable:

| Constraint | Source |
|---|---|
| RLS with `ENABLE` + `FORCE`, `USING` + `WITH CHECK`, in the same migration | `12` §4 |
| Grants to `darex_app` in the same migration | `14` §0 |
| No KYC / PAN / Aadhaar columns; honour `compliance.blockedDataClasses` | `013_memory_rag`, `core-b2b` |
| Extraction never on a request thread | `ingestion_jobs` migration comment |
| Idempotent on content hash | every existing ingest path |
| `error` columns must not store secrets | `ingestion_jobs` |
| Vectors and records stay in one Postgres | `19` D1, D8 |
| Contradictions escalate to `work_items` rather than resolving silently | `04` §3.5 |

---

## 3. Schema

### 3.1 `entities` — the nodes

```sql
CREATE TABLE IF NOT EXISTS entities (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,          -- person | account | asset | document |
                                        -- transaction | commitment | obligation
  display_name  TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',   -- active | merged | archived
  merged_into   UUID REFERENCES entities(id) ON DELETE SET NULL,
  pack_id       TEXT REFERENCES packs(id) ON DELETE SET NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT entities_status_chk CHECK (status IN ('active','merged','archived')),
  CONSTRAINT entities_merge_chk  CHECK (
    (status = 'merged') = (merged_into IS NOT NULL)
  )
);
```

`merged_into` with the paired `CHECK` means a merge is **non-destructive**: the
losing node survives as a redirect, so any citation that pointed at it still
resolves. A merge that deletes rows is unreviewable and unrecoverable.

`pack_id` records which pack registered the type, so uninstalling a pack knows
what it owns.

### 3.2 `entity_identifiers` — how the outside world names a node

```sql
CREATE TABLE IF NOT EXISTS entity_identifiers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  entity_id     UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,   -- phone | email | crm_id | mls_id | wa_id | listing_ref
  value_norm    TEXT NOT NULL,   -- normalised: E.164, lowercased email, trimmed id
  source        TEXT NOT NULL DEFAULT '',
  confidence    REAL NOT NULL DEFAULT 1.0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_identifiers_unique
  ON entity_identifiers (org_id, kind, value_norm);
```

**The unique index is the deterministic resolver.** One phone number maps to one
entity per org. Inserting a duplicate is a conflict the pipeline must resolve
rather than a silent second node, which is how "same person, four half-memories"
happens today.

Normalisation happens **before** write (E.164 for phone, lowercase for email),
because the index is only as good as the normaliser.

### 3.3 `facts` — the typed claims

```sql
CREATE TABLE IF NOT EXISTS facts (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id             UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  subject_id         UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate          TEXT NOT NULL,      -- from a pack-registered vocabulary
  object_type        TEXT NOT NULL,      -- text | number | money | date | bool | ref
  object_text        TEXT,
  object_number      NUMERIC,
  object_money_minor BIGINT,             -- minor units; never a float
  object_currency    CHAR(3),
  object_date        TIMESTAMPTZ,
  object_bool        BOOLEAN,
  object_ref         UUID REFERENCES entities(id) ON DELETE SET NULL,

  confidence         REAL NOT NULL DEFAULT 0.0,
  valid_from         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to           TIMESTAMPTZ,        -- NULL = currently true

  source_kind        TEXT NOT NULL,      -- message | document | tool_result |
                                         -- sync_row | human | pack
  source_ref         TEXT NOT NULL DEFAULT '',
  evidence_memory_id UUID,               -- the memory row that carries the prose
  extracted_by_model TEXT,
  extracted_by_prompt_hash TEXT,

  status             TEXT NOT NULL DEFAULT 'current',
  corrected_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  superseded_by      UUID REFERENCES facts(id) ON DELETE SET NULL,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT facts_status_chk CHECK (
    status IN ('current','superseded','contradicted','retracted')
  ),
  CONSTRAINT facts_confidence_chk CHECK (confidence >= 0.0 AND confidence <= 1.0),
  CONSTRAINT facts_money_chk CHECK (
    (object_type <> 'money') OR
    (object_money_minor IS NOT NULL AND object_currency IS NOT NULL)
  ),
  CONSTRAINT facts_validity_chk CHECK (valid_to IS NULL OR valid_to > valid_from)
);
```

Design notes, each earning its place:

- **Typed object columns, not a JSONB blob.** A watcher comparing "rent due
  within 7 days" must filter on a real `TIMESTAMPTZ` with an index. JSONB
  extraction in a `WHERE` clause does not scale and cannot be constrained.
- **`object_money_minor BIGINT` + `object_currency`.** Money as a float is a bug
  waiting for a rounding complaint. The `CHECK` makes currency mandatory
  whenever the type is money — a naked amount is not a fact.
- **`extracted_by_prompt_hash`** mirrors `audit_events.prompt_hash`. When a
  prompt regression starts producing bad facts, **every fact it produced is
  identifiable and retractable** with one query. This is the single most
  valuable column in the table and costs nothing.
- **`evidence_memory_id`** points at the prose chunk. Facts do not replace
  memory; they index into it. Every fact remains explainable by opening the
  message it came from.
- **`superseded_by` + four statuses.** `superseded` (a newer fact replaced it),
  `contradicted` (two facts disagree and neither wins yet), `retracted` (a human
  or a prompt rollback withdrew it). Deleting instead would erase the history
  the audit surface needs.

#### Indexes

```sql
CREATE INDEX idx_facts_subject     ON facts (org_id, subject_id, predicate)
  WHERE status = 'current';
CREATE INDEX idx_facts_predicate   ON facts (org_id, predicate)
  WHERE status = 'current';
CREATE INDEX idx_facts_date        ON facts (org_id, predicate, object_date)
  WHERE status = 'current' AND object_date IS NOT NULL;
CREATE INDEX idx_facts_validity    ON facts (org_id, valid_to)
  WHERE status = 'current' AND valid_to IS NULL;
CREATE INDEX idx_facts_prompt_hash ON facts (org_id, extracted_by_prompt_hash);
```

Every hot index is **partial on `status='current'`**. Superseded history
accumulates without slowing the queries that only care about what is true now —
the same instinct as the partial HNSW index on `embedding IS NOT NULL`.

`idx_facts_date` is the watcher index: "every obligation with a due date inside
the window" is one index scan per org.

### 3.4 `fact_conflicts` — disagreement as data

```sql
CREATE TABLE IF NOT EXISTS fact_conflicts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  subject_id    UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate     TEXT NOT NULL,
  fact_a        UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  fact_b        UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  resolution    TEXT NOT NULL DEFAULT 'open',
                -- open | recency | trust | human | both_valid
  resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  work_item_id  UUID REFERENCES work_items(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);
```

`both_valid` is a real outcome, not a cop-out: a buyer can genuinely want two
localities. The reconciler must be able to say "these do not actually conflict"
without discarding either.

`work_item_id` is the join to the existing human queue. Contradictions do not
need a new escalation mechanism — they need to use the one that exists.

### 3.5 Predicate vocabulary — packs own it

```sql
CREATE TABLE IF NOT EXISTS predicate_defs (
  key             TEXT PRIMARY KEY,       -- 're.listing.price', 'core.contact.email'
  pack_id         TEXT REFERENCES packs(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL,
  object_type     TEXT NOT NULL,
  cardinality     TEXT NOT NULL DEFAULT 'one',   -- one | many
  extractable     BOOLEAN NOT NULL DEFAULT true,
  min_confidence  REAL NOT NULL DEFAULT 0.7,
  requires_tool_evidence BOOLEAN NOT NULL DEFAULT false,
  blocked_data_class TEXT,
  description     TEXT NOT NULL DEFAULT ''
);
```

Three fields carry the safety of the whole pipeline:

- **`cardinality`** — `one` means a new fact supersedes the old (a listing has
  one price); `many` means they coexist (a buyer wants three localities).
  Without this, the reconciler cannot know whether a difference is an update or
  a conflict, and it is a **per-predicate** answer, not a global rule.
- **`requires_tool_evidence`** — a price extracted from a chat message is a
  claim; a price from a Sheets read is a fact. Predicates that move money or set
  prices demand `source_kind = 'tool_result'`. This mirrors the existing
  write-back test: *"inferred list_price without tool results is
  needs_attention"*.
- **`blocked_data_class`** — a predicate tagged `kyc` is never extracted,
  regardless of what a model proposes.

Packs register predicates the same way they register entities and KPIs. A
vertical adds vocabulary without a platform code change (`12` §5).

---

## 4. The extraction pipeline

Runs as `FactExtractWorkflow`, enqueued by `MemoryWriteBackWorkflow` and by
`IngestWorkflow`. Never on a request thread.

```
input: { orgId, sourceKind, sourceRef, memoryId, text, entityHints[] }
  │
  1. REDACT        reuse the existing redact activity; blocked classes dropped
  │                (already tested: strips API keys, PAN, aadhaar, card numbers)
  2. HASH          content_hash of redacted text → skip if already extracted
  3. GATE          cheap classifier: does this plausibly contain facts?
  │                greetings and receipts exit here — most inbound is not facts
  4. EXTRACT       LiteLLM JSON, reasoning off, predicates restricted to
  │                predicate_defs for the org's installed packs
  5. RESOLVE       for each subject → entity_identifiers exact match
  │                  ├─ hit          → that entity
  │                  ├─ fuzzy ≥ .90  → that entity, log the score
  │                  ├─ fuzzy .70-.90→ create + merge-review work item
  │                  └─ no match     → create new entity
  6. RECONCILE     per (subject, predicate) — see §5
  7. WRITE         facts + edges, one transaction per subject
  8. AUDIT         audit_events with model + prompt_hash
```

### Step 3 is the cost control

A gate that rejects greetings, delivery receipts, and one-word replies before
the expensive extraction call is the difference between an affordable pipeline
and one that costs more than the subscription. The router already proves the
pattern — `GREETING_RE` short-circuits before any model call.

### Step 4 restricts the vocabulary

The extractor is given the **list of valid predicates** for the org's installed
packs and told to emit nothing else. An open-vocabulary extractor produces
`wants_2bhk`, `desires_2_bhk`, and `looking_for_2BHK` as three predicates and
the graph becomes unqueryable within a week.

---

## 5. Reconciliation rules

For each incoming candidate against existing `current` facts on the same
`(subject_id, predicate)`:

```
if predicate.cardinality = 'many':
    write as an additional current fact; no conflict

if candidate.object equals existing.object:
    bump existing.confidence toward 1.0 (corroboration), update nothing else

if existing.corrected_by_user_id IS NOT NULL:
    → a human correction is authoritative
    → never auto-supersede; open a fact_conflict only if
      candidate.source_kind = 'tool_result'

if candidate.confidence < predicate.min_confidence:
    → do not write as current; needs_attention work item

if predicate.requires_tool_evidence AND candidate.source_kind <> 'tool_result':
    → do not write as current; needs_attention work item

if candidate.source_kind rank > existing.source_kind rank:
    → supersede: existing.status='superseded', superseded_by=new.id,
      existing.valid_to = candidate.valid_from

if same rank AND candidate is newer AND confidence >= existing.confidence:
    → supersede by recency

otherwise:
    → fact_conflict(resolution='open') + work item
```

### Source trust ranking

```
human (explicit correction) > tool_result > document > sync_row > message > pack default
```

A signed agreement outranks a WhatsApp claim. A tool read outranks both. This
ordering answers `07` §8's "source trust levels" gap and belongs in one constant
so it is auditable rather than scattered through prompts.

**The human-correction rule is the important one.** Once a person has corrected
a fact, no extraction overwrites it. Only a tool result may even *challenge* it,
and then only by opening a conflict a human resolves. Anything weaker and the
correct-this-fact control is theatre.

---

## 6. Entity resolution

```
deterministic:  entity_identifiers (org_id, kind, value_norm) unique index
probabilistic:  name + one weak identifier, scored
  ≥ 0.90  auto-link, log the score on entity_identifiers.confidence
  0.70-0.90  create separately + merge_review work item
  < 0.70  distinct entities
```

**A wrong merge leaks one customer's history into another's thread.** Treat it
with the same seriousness as a tenancy bug: the auto-link threshold is
deliberately high, and everything below it is a human decision.

Merges are non-destructive (`status='merged'`, `merged_into`), so a bad merge is
reversible and every existing citation still resolves.

---

## 7. Retrieval integration

`retrieveMemory` gains a **structured-first** stage before the hybrid search:

```
1. detect entity references in the query (identifiers, names, explicit ids)
2. if found → SELECT facts WHERE subject_id = ANY($1) AND status='current'
              AND (valid_to IS NULL OR valid_to > now())
              ORDER BY predicate, confidence DESC
3. render facts as a structured block, with fact ids as citations
4. one-hop memory_edges expansion from the locked entities, weight-ordered
5. hybrid FTS + vector for everything not covered
6. fuse (RRF), rerank, apply the 3000-token budget
```

The fact block is rendered **before** the prose block and labelled as
authoritative. The model's job becomes rendering retrieved truth, not sourcing
the claim.

Budget impact: step 2 is a single indexed query, well inside the existing 1200ms
retrieval budget — it is *cheaper* than the vector path it partially replaces.

---

## 8. The `/brain` entity page

What the fact model makes possible:

| Element | Source |
|---|---|
| Identity and aliases | `entity_identifiers` |
| Current facts, grouped by predicate | `facts WHERE status='current'` |
| Confidence badge per fact | `facts.confidence` |
| "Because of this message" link | `evidence_memory_id` → `/api/brain/[id]` |
| Conflict banner | `fact_conflicts WHERE resolution='open'` |
| History timeline | superseded facts by `valid_from` |
| Correct-this-fact control | writes a fact with `corrected_by_user_id` |
| Related entities | `memory_edges`, weight-ordered |
| Forget | cascade from `subject_id` |

The correct-this-fact control is the feature that converts a sceptical customer.
It changes the relationship from "the AI said something wrong" to "I taught it",
and the teaching is permanent by the reconciliation rules above.

---

## 9. Migration and rollout

`022_entity_graph.sql` — additive only. Nothing existing changes.

Rollout in four stages, each independently shippable:

1. **Shadow.** Pipeline runs and writes facts; retrieval ignores them. Compare
   extracted facts against `entity_memory` prose manually on a real org.
2. **Read-only surface.** `/brain` entity pages render facts. Customers see them
   and can correct them. Answers still come from prose.
3. **Retrieval integration.** Structured-first goes live behind a per-org flag.
   Golden suites must not regress.
4. **Watchers.** Only after facts have been observed correct for a month, since
   a watcher firing on a wrong fact is worse than no watcher.

Rollback at any stage is dropping the read path; the tables stay.

---

## 10. Evals this must ship with

| Golden | Asserts |
|---|---|
| `facts-extraction.yaml` | Known message → expected `(subject, predicate, object)`; nothing outside the vocabulary |
| `facts-contradiction.yaml` | Two conflicting messages produce a `fact_conflict`, **not** an averaged answer |
| `facts-correction.yaml` | A human correction outranks a later extraction, permanently |
| `facts-tool-evidence.yaml` | A price from chat is `needs_attention`; the same price from a tool applies |
| `facts-resolution.yaml` | Same person on WhatsApp and email resolves to one entity; two similar-named strangers do not |
| `facts-blocked-class.yaml` | A message containing a PAN produces **no** fact and no memory row with the number |
| `facts-rls.yaml` | Two-org isolation on `facts`, `entities`, `entity_identifiers` |
| `facts-empty.yaml` | An org with no facts answers honestly and does not invent |

Per `18` §2, each honesty-shaped golden writes down the exact plausible lie as
`negativeOutput`.

---

## 11. Open questions

| Question | Options | Decide by |
|---|---|---|
| Do commitments and obligations get their own tables or live as entity types with predicates? | Entity types are more uniform; dedicated tables index better for the watcher path | Before Phase B |
| Fact-level embeddings for semantic predicate matching? | Probably unnecessary if the vocabulary is closed | After shadow stage |
| Decay: should confidence fall with age, or only staleness be displayed? | Displaying staleness is honest; decaying confidence is a silent judgement | Before retrieval integration |
| Cross-entity derived facts ("this buyer is stalled") — stored or computed? | Computed keeps the graph honest; stored makes watchers cheap | Phase B |
| Pack uninstall: retract its facts, or orphan the predicates? | Retract with `status='retracted'`, never delete | Before the second vertical pack ships |
