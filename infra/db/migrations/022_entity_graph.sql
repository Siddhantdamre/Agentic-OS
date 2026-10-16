-------------------------------------------------------------------------------
-- Entity Graph and Fact Model — Migration 022 (Company Brain, Tier 1.1)
--
-- Implements docs/2-sept/21-spec-entity-graph.md §3. Additive only: nothing
-- existing changes. Stores typed, comparable, contradictable facts alongside
-- the prose in entity_memory (kept as evidence via facts.evidence_memory_id).
--
-- Rollout is staged (spec §9): this migration ships the tables. The extraction
-- pipeline writes facts in "shadow" mode; retrieval ignores them until a
-- per-org flag turns structured-first on.
--
-- Tenancy: every org-scoped table gets RLS ENABLE + FORCE with USING +
-- WITH CHECK in this same migration (12 §4). Grants to darex_app here (14 §0).
-- predicate_defs is a global catalog (like packs) — read-all, writes via seed.
--
-- File: infra/db/migrations/022_entity_graph.sql
-------------------------------------------------------------------------------

-------------------------------------------------------------------------------
-- 1. entities — the nodes
-------------------------------------------------------------------------------

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
  -- a merge is non-destructive: the losing node survives as a redirect so any
  -- citation that pointed at it still resolves.
  CONSTRAINT entities_merge_chk  CHECK (
    (status = 'merged') = (merged_into IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_entities_org_type
  ON entities (org_id, entity_type) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_entities_merged_into
  ON entities (merged_into) WHERE merged_into IS NOT NULL;

ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE entities FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entities_org_isolation ON entities;
CREATE POLICY entities_org_isolation ON entities
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

DROP TRIGGER IF EXISTS trg_entities_updated_at ON entities;
CREATE TRIGGER trg_entities_updated_at
  BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

GRANT SELECT, INSERT, UPDATE, DELETE ON entities TO darex_app;

COMMENT ON TABLE entities IS
  'Company-brain nodes. Merges are non-destructive (status=merged, merged_into).';
COMMENT ON COLUMN entities.pack_id IS
  'Pack that registered the type — uninstalling a pack knows what it owns.';

-------------------------------------------------------------------------------
-- 2. entity_identifiers — how the outside world names a node
--
-- The unique index (org_id, kind, value_norm) IS the deterministic resolver:
-- one phone number maps to one entity per org. Normalisation (E.164 for phone,
-- lowercase for email) happens BEFORE write — the index is only as good as the
-- normaliser.
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entity_identifiers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  entity_id     UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,   -- phone | email | crm_id | mls_id | wa_id | listing_ref
  value_norm    TEXT NOT NULL,   -- normalised: E.164, lowercased email, trimmed id
  source        TEXT NOT NULL DEFAULT '',
  confidence    REAL NOT NULL DEFAULT 1.0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT entity_identifiers_confidence_chk CHECK (confidence >= 0.0 AND confidence <= 1.0),
  CONSTRAINT entity_identifiers_value_chk CHECK (btrim(value_norm) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_identifiers_unique
  ON entity_identifiers (org_id, kind, value_norm);
CREATE INDEX IF NOT EXISTS idx_entity_identifiers_entity
  ON entity_identifiers (org_id, entity_id);

ALTER TABLE entity_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_identifiers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_identifiers_org_isolation ON entity_identifiers;
CREATE POLICY entity_identifiers_org_isolation ON entity_identifiers
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON entity_identifiers TO darex_app;

COMMENT ON TABLE entity_identifiers IS
  'Deterministic entity resolver. (org_id, kind, value_norm) is unique — a '
  'duplicate insert is a conflict the pipeline resolves, not a silent 2nd node.';

-------------------------------------------------------------------------------
-- 3. predicate_defs — the predicate vocabulary, owned by packs
--
-- Global catalog like packs: read-all, writes via seed / superuser. cardinality,
-- requires_tool_evidence and blocked_data_class carry the safety of the whole
-- extraction pipeline (spec §3.5).
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS predicate_defs (
  key             TEXT PRIMARY KEY,       -- 're.listing.price', 'core.contact.email'
  pack_id         TEXT REFERENCES packs(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL,
  object_type     TEXT NOT NULL,          -- text | number | money | date | bool | ref
  cardinality     TEXT NOT NULL DEFAULT 'one',   -- one | many
  extractable     BOOLEAN NOT NULL DEFAULT true,
  min_confidence  REAL NOT NULL DEFAULT 0.7,
  requires_tool_evidence BOOLEAN NOT NULL DEFAULT false,
  blocked_data_class TEXT,
  description     TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT predicate_defs_cardinality_chk CHECK (cardinality IN ('one','many')),
  CONSTRAINT predicate_defs_object_type_chk CHECK (
    object_type IN ('text','number','money','date','bool','ref')
  ),
  CONSTRAINT predicate_defs_min_confidence_chk CHECK (
    min_confidence >= 0.0 AND min_confidence <= 1.0
  )
);

ALTER TABLE predicate_defs ENABLE ROW LEVEL SECURITY;
ALTER TABLE predicate_defs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS predicate_defs_read_all ON predicate_defs;
CREATE POLICY predicate_defs_read_all ON predicate_defs
  FOR SELECT USING (true);

DROP POLICY IF EXISTS predicate_defs_write_all ON predicate_defs;
CREATE POLICY predicate_defs_write_all ON predicate_defs
  FOR ALL USING (current_setting('app.current_org_id', true) IS NULL)
  WITH CHECK (current_setting('app.current_org_id', true) IS NULL);

GRANT SELECT ON predicate_defs TO darex_app;

COMMENT ON TABLE predicate_defs IS
  'Closed predicate vocabulary. The extractor is restricted to these keys for '
  'the org installed packs — an open vocabulary makes the graph unqueryable.';
COMMENT ON COLUMN predicate_defs.cardinality IS
  'one = a new fact supersedes the old; many = they coexist. Per-predicate, not global.';
COMMENT ON COLUMN predicate_defs.requires_tool_evidence IS
  'true = a value from chat is a claim (needs_attention); only source_kind=tool_result applies.';

-------------------------------------------------------------------------------
-- 4. facts — the typed claims
--
-- Typed object columns (not a JSONB blob) so a watcher can filter on a real
-- indexed TIMESTAMPTZ. Money is minor units + mandatory currency, never a float.
-- extracted_by_prompt_hash mirrors audit_events.prompt_hash: when a prompt
-- regression produces bad facts, every one is identifiable and retractable.
-------------------------------------------------------------------------------

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
  CONSTRAINT facts_object_type_chk CHECK (
    object_type IN ('text','number','money','date','bool','ref')
  ),
  CONSTRAINT facts_source_kind_chk CHECK (
    source_kind IN ('message','document','tool_result','sync_row','human','pack')
  ),
  CONSTRAINT facts_money_chk CHECK (
    (object_type <> 'money') OR
    (object_money_minor IS NOT NULL AND object_currency IS NOT NULL)
  ),
  CONSTRAINT facts_validity_chk CHECK (valid_to IS NULL OR valid_to > valid_from)
);

-- Every hot index is partial on status='current': superseded history
-- accumulates without slowing the queries that only care about what is true now.
CREATE INDEX IF NOT EXISTS idx_facts_subject     ON facts (org_id, subject_id, predicate)
  WHERE status = 'current';
CREATE INDEX IF NOT EXISTS idx_facts_predicate   ON facts (org_id, predicate)
  WHERE status = 'current';
-- the watcher index: "every obligation with a due date inside the window".
CREATE INDEX IF NOT EXISTS idx_facts_date        ON facts (org_id, predicate, object_date)
  WHERE status = 'current' AND object_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facts_validity    ON facts (org_id, valid_to)
  WHERE status = 'current' AND valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_prompt_hash ON facts (org_id, extracted_by_prompt_hash);
CREATE INDEX IF NOT EXISTS idx_facts_evidence    ON facts (evidence_memory_id)
  WHERE evidence_memory_id IS NOT NULL;

ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS facts_org_isolation ON facts;
CREATE POLICY facts_org_isolation ON facts
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

DROP TRIGGER IF EXISTS trg_facts_updated_at ON facts;
CREATE TRIGGER trg_facts_updated_at
  BEFORE UPDATE ON facts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

GRANT SELECT, INSERT, UPDATE, DELETE ON facts TO darex_app;

COMMENT ON TABLE facts IS
  'Typed, comparable, contradictable claims. Facts index into memory (via '
  'evidence_memory_id), they do not replace it. Never deleted — status tracks history.';
COMMENT ON COLUMN facts.object_money_minor IS
  'Minor units (paise/cents). Never a float. facts_money_chk makes currency mandatory.';
COMMENT ON COLUMN facts.extracted_by_prompt_hash IS
  'Mirrors audit_events.prompt_hash. Retract every fact from a bad prompt with one query.';
COMMENT ON COLUMN facts.corrected_by_user_id IS
  'Set = a human corrected this fact. No extraction ever auto-supersedes it (spec §5).';

-------------------------------------------------------------------------------
-- 5. fact_conflicts — disagreement as data
--
-- Contradictions escalate to the existing work_items queue rather than
-- resolving silently (04 §3.5). both_valid is a real outcome, not a cop-out.
-------------------------------------------------------------------------------

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
  resolved_at   TIMESTAMPTZ,
  CONSTRAINT fact_conflicts_resolution_chk CHECK (
    resolution IN ('open','recency','trust','human','both_valid')
  ),
  CONSTRAINT fact_conflicts_distinct_chk CHECK (fact_a <> fact_b)
);

CREATE INDEX IF NOT EXISTS idx_fact_conflicts_open
  ON fact_conflicts (org_id, subject_id) WHERE resolution = 'open';
CREATE INDEX IF NOT EXISTS idx_fact_conflicts_work_item
  ON fact_conflicts (work_item_id) WHERE work_item_id IS NOT NULL;

ALTER TABLE fact_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fact_conflicts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fact_conflicts_org_isolation ON fact_conflicts;
CREATE POLICY fact_conflicts_org_isolation ON fact_conflicts
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

GRANT SELECT, INSERT, UPDATE, DELETE ON fact_conflicts TO darex_app;

COMMENT ON TABLE fact_conflicts IS
  'Two current facts disagree and neither wins yet. Joins to the human queue '
  'via work_item_id — no new escalation mechanism.';
