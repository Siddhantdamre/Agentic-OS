-------------------------------------------------------------------------------
-- Memory RAG schema — Migration 013 (workstream 03 / M1)
-- Additive org-scoped memory + knowledge ingest tables. pgvector is enabled
-- in infra/db/init; this migration actually uses it.
--
-- Tiers (future-scope 10 §2, plan 03 §4.1):
--   org_memory            — SOP / brand / faq / area_book / policy (every turn)
--   employee_memory       — per ai_employee learned patterns
--   entity_memory         — confirmed facts keyed by (entity_type, entity_id)
--   conversation_memory   — thread summaries + similar-thread recall
--   memory_edges          — extracted relations (multi-hop later; not a graph DB)
--   knowledge_sources     — Drive/Notion/upload/pack/crawl catalog + content hash
--   ingestion_jobs        — async parse/embed jobs (worker is WS-04, not this file)
--
-- Embedding dimension:
--   Column type is vector(1536). This MUST match env EMBEDDING_DIM. Do not mix
--   dims in one column. App fail-fast if EMBEDDING_MODEL / EMBEDDING_DIM are
--   unset is WS-04 (embed-worker). Changing the model/dim requires a follow-up
--   migration + reembed job — never ALTER in place while rows exist.
--   No model names are hardcoded here.
--
-- Deliberately omitted: KYC / PAN / Aadhaar columns. Do not embed KYC. Do not
-- store government ID numbers on these tables.
-- File: infra/db/migrations/013_memory_rag.sql
-------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-------------------------------------------------------------------------------
-- 1. ORG MEMORY
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS org_memory (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind          TEXT,                    -- sop, brand, faq, area_book, policy
  title         TEXT,
  body          TEXT NOT NULL,
  -- dim = EMBEDDING_DIM (documented 1536). NULL until embed-worker (WS-04).
  embedding     vector(1536),
  source        TEXT NOT NULL DEFAULT '',   -- drive, notion, upload, pack, crawl
  source_ref    TEXT NOT NULL DEFAULT '',
  content_hash  TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  body_tsv      tsvector GENERATED ALWAYS AS (
                  to_tsvector(
                    'english',
                    coalesce(title, '') || ' ' || coalesce(body, '')
                  )
                ) STORED
);

ALTER TABLE org_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_memory FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_memory_org_isolation ON org_memory;
CREATE POLICY org_memory_org_isolation ON org_memory
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_memory_content_hash
  ON org_memory (org_id, source, source_ref, content_hash);
CREATE INDEX IF NOT EXISTS idx_org_memory_org_id ON org_memory (org_id);
CREATE INDEX IF NOT EXISTS idx_org_memory_kind ON org_memory (org_id, kind);
CREATE INDEX IF NOT EXISTS idx_org_memory_body_tsv ON org_memory USING gin (body_tsv);
CREATE INDEX IF NOT EXISTS idx_org_memory_embedding_hnsw
  ON org_memory USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

DROP TRIGGER IF EXISTS trg_org_memory_updated_at ON org_memory;
CREATE TRIGGER trg_org_memory_updated_at
  BEFORE UPDATE ON org_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE org_memory IS
  'Org-tier RAG chunks (SOP/brand/faq). RLS org_id. Embedding dim = EMBEDDING_DIM (vector(1536)); fail-fast is WS-04.';
COMMENT ON COLUMN org_memory.embedding IS
  'pgvector cosine; dim must equal env EMBEDDING_DIM. Do not mix dims. NULL until embed-worker.';
COMMENT ON COLUMN org_memory.content_hash IS
  'Idempotent upsert key with (org_id, source, source_ref). Skip reembed when unchanged.';

-------------------------------------------------------------------------------
-- 2. EMPLOYEE MEMORY
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employee_memory (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_id   UUID NOT NULL REFERENCES ai_employees(id) ON DELETE CASCADE,
  kind          TEXT,
  title         TEXT,
  body          TEXT NOT NULL,
  embedding     vector(1536),
  source        TEXT NOT NULL DEFAULT '',
  source_ref    TEXT NOT NULL DEFAULT '',
  content_hash  TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  body_tsv      tsvector GENERATED ALWAYS AS (
                  to_tsvector(
                    'english',
                    coalesce(title, '') || ' ' || coalesce(body, '')
                  )
                ) STORED
);

ALTER TABLE employee_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_memory FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_memory_org_isolation ON employee_memory;
CREATE POLICY employee_memory_org_isolation ON employee_memory
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE UNIQUE INDEX IF NOT EXISTS idx_employee_memory_content_hash
  ON employee_memory (org_id, source, source_ref, content_hash);
CREATE INDEX IF NOT EXISTS idx_employee_memory_employee
  ON employee_memory (org_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_memory_body_tsv
  ON employee_memory USING gin (body_tsv);
CREATE INDEX IF NOT EXISTS idx_employee_memory_embedding_hnsw
  ON employee_memory USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

DROP TRIGGER IF EXISTS trg_employee_memory_updated_at ON employee_memory;
CREATE TRIGGER trg_employee_memory_updated_at
  BEFORE UPDATE ON employee_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE employee_memory IS
  'Per-employee RAG chunks. Retrieved on that employee''s turns. Same embedding-dim contract as org_memory.';

-------------------------------------------------------------------------------
-- 3. ENTITY MEMORY
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entity_memory (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  kind          TEXT,
  title         TEXT,
  body          TEXT NOT NULL,
  embedding     vector(1536),
  source        TEXT NOT NULL DEFAULT '',
  source_ref    TEXT NOT NULL DEFAULT '',
  content_hash  TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  body_tsv      tsvector GENERATED ALWAYS AS (
                  to_tsvector(
                    'english',
                    coalesce(title, '') || ' ' || coalesce(body, '')
                  )
                ) STORED
);

ALTER TABLE entity_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_memory FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS entity_memory_org_isolation ON entity_memory;
CREATE POLICY entity_memory_org_isolation ON entity_memory
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_memory_content_hash
  ON entity_memory (org_id, source, source_ref, content_hash);
CREATE INDEX IF NOT EXISTS idx_entity_memory_entity
  ON entity_memory (org_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_memory_body_tsv
  ON entity_memory USING gin (body_tsv);
CREATE INDEX IF NOT EXISTS idx_entity_memory_embedding_hnsw
  ON entity_memory USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

DROP TRIGGER IF EXISTS trg_entity_memory_updated_at ON entity_memory;
CREATE TRIGGER trg_entity_memory_updated_at
  BEFORE UPDATE ON entity_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE entity_memory IS
  'Confirmed entity facts. btree (org_id, entity_type, entity_id) for lock-first retrieve. No KYC/PAN columns.';
COMMENT ON COLUMN entity_memory.entity_id IS
  'Opaque external or internal id (TEXT so CRM/MLS keys fit). Always filtered with org_id.';

-------------------------------------------------------------------------------
-- 4. CONVERSATION MEMORY
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversation_memory (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id           UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind             TEXT,
  title            TEXT,
  summary          TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  embedding        vector(1536),
  source           TEXT NOT NULL DEFAULT '',
  source_ref       TEXT NOT NULL DEFAULT '',
  content_hash     TEXT NOT NULL,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  body_tsv         tsvector GENERATED ALWAYS AS (
                     to_tsvector(
                       'english',
                       coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(body, '')
                     )
                   ) STORED
);

ALTER TABLE conversation_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_memory FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_memory_org_isolation ON conversation_memory;
CREATE POLICY conversation_memory_org_isolation ON conversation_memory
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_memory_content_hash
  ON conversation_memory (org_id, source, source_ref, content_hash);
CREATE INDEX IF NOT EXISTS idx_conversation_memory_conversation
  ON conversation_memory (org_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_memory_body_tsv
  ON conversation_memory USING gin (body_tsv);
CREATE INDEX IF NOT EXISTS idx_conversation_memory_embedding_hnsw
  ON conversation_memory USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

DROP TRIGGER IF EXISTS trg_conversation_memory_updated_at ON conversation_memory;
CREATE TRIGGER trg_conversation_memory_updated_at
  BEFORE UPDATE ON conversation_memory
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE conversation_memory IS
  'Thread summaries written every N messages + on close. Retrieved for same + similar threads.';

-------------------------------------------------------------------------------
-- 5. MEMORY EDGES (relation graph in Postgres; Apache AGE later if needed)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS memory_edges (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  from_id       UUID NOT NULL,
  to_id         UUID NOT NULL,
  from_kind     TEXT,                    -- org_memory | employee_memory | entity_memory | conversation_memory
  to_kind       TEXT,
  rel           TEXT NOT NULL,           -- inquired_about, shown, owns, employs, cites, ...
  weight        REAL NOT NULL DEFAULT 1.0,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE memory_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_edges FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_edges_org_isolation ON memory_edges;
CREATE POLICY memory_edges_org_isolation ON memory_edges
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_edges_unique
  ON memory_edges (org_id, from_id, to_id, rel);
CREATE INDEX IF NOT EXISTS idx_memory_edges_from ON memory_edges (org_id, from_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_to ON memory_edges (org_id, to_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_rel ON memory_edges (org_id, rel);

DROP TRIGGER IF EXISTS trg_memory_edges_updated_at ON memory_edges;
CREATE TRIGGER trg_memory_edges_updated_at
  BEFORE UPDATE ON memory_edges
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE memory_edges IS
  'Typed relations between memory rows (UUIDs are polymorphic; no FK). Graph hops stay in-RLS.';

-------------------------------------------------------------------------------
-- 6. KNOWLEDGE SOURCES
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connector     TEXT NOT NULL,           -- drive, notion, upload, pack, crawl
  path          TEXT NOT NULL,
  content_hash  TEXT,                    -- plan field: hash — source-file hash for incremental ingest
  last_synced   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending, syncing, ready, error, disabled
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_sources FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS knowledge_sources_org_isolation ON knowledge_sources;
CREATE POLICY knowledge_sources_org_isolation ON knowledge_sources
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_sources_path
  ON knowledge_sources (org_id, connector, path);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_org_id ON knowledge_sources (org_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_sources_status
  ON knowledge_sources (org_id, status);

DROP TRIGGER IF EXISTS trg_knowledge_sources_updated_at ON knowledge_sources;
CREATE TRIGGER trg_knowledge_sources_updated_at
  BEFORE UPDATE ON knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE knowledge_sources IS
  'Ingest catalog. Disabled sources must not be retrieved (M5). Hash skip when unchanged.';
COMMENT ON COLUMN knowledge_sources.content_hash IS
  'Source-file hash (plan: hash). Embed-worker skips when equal.';

-------------------------------------------------------------------------------
-- 7. INGESTION JOBS (enqueue off the webhook thread — worker is WS-04)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT 'queued',  -- queued, running, succeeded, failed, cancelled
  cursor        TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

ALTER TABLE ingestion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ingestion_jobs_org_isolation ON ingestion_jobs;
CREATE POLICY ingestion_jobs_org_isolation ON ingestion_jobs
  USING (org_id = current_setting('app.current_org_id', true)::UUID)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::UUID);

CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_source
  ON ingestion_jobs (org_id, source_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_state
  ON ingestion_jobs (org_id, state);

DROP TRIGGER IF EXISTS trg_ingestion_jobs_updated_at ON ingestion_jobs;
CREATE TRIGGER trg_ingestion_jobs_updated_at
  BEFORE UPDATE ON ingestion_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE ingestion_jobs IS
  'Async ingest/embed jobs. Never run on the WhatsApp request thread. error must not store secrets.';

-------------------------------------------------------------------------------
-- Grants — match 011 (explicit + blanket so darex_app can DML)
-------------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON org_memory TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_memory TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON entity_memory TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_memory TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON memory_edges TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_sources TO darex_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ingestion_jobs TO darex_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO darex_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO darex_app;
