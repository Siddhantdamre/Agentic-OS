# Brain Audit

## Status: closed (hybrid search, edit re-embed, create/upload, revisions, cascade invalidation, reindex DRY, sentence chunker)

## Live Resolution Tracker
| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | PATCH correct does not enqueue re-embed → vector divergence | P0 | `apps/dashboard/app/api/brain/[id]/route.ts` PATCH | 🟢 | Snapshot → `memory_revisions`, UPDATE body + NULL embedding, release client, `enqueueEmbedJob({ replaceMemory })` |
| 2 | Brain UI search keyword-only vs agent hybrid | P0 | `apps/dashboard/app/api/brain/route.ts` GET; `retrieve.ts` `searchMemoryHybrid` | 🟢 | Embed after release; hybrid FTS+cosine; keyword fallback + `searchMode` when vectors missing |
| 3 | Ghost vectors on delete / stale vectors on edit | P0 | `092_memory_cascade.sql`; DELETE path | 🟢 | Vectors are columns on `*_memory`; DELETE removes them; trigger nulls embedding on body change |
| 4 | Missing POST create for manual SOP snippets | P1 | `POST /api/brain` `create`/`upload` | 🟢 | Session org insert + in-place embed; upload accepts .txt/.md only (honest reject for PDF/DOCX) |
| 5 | Triple-duplicate reindex implementations | P1 | `lib/brain-reindex.ts` | 🟢 | Shared load+enqueue for `/api/brain` and `/api/brain/[id]`; `/reindex` is Sync/Ingest only (documented) |
| 6 | Revision history / sentence chunker / text upload | P1 | `memory_revisions`, `chunkTextSentenceAware`, upload action | 🟢 | Revisions API + PATCH snapshot; sentence-aware chunk enqueue; text upload path |
| 7 | Raw transcripts / facts sent to Cognee unredacted; no server-side Cognee auth (`MEM-S01`, `MEM-S03`) | P0 | `memory/cognee-client.ts` `rememberCognee`; `infra/docker-compose.yml` cognee | 🟡 | Redaction closed in client (unit test). Server auth wired but off until a human mints a Cognee API key and sets `COGNEE_REQUIRE_AUTHENTICATION=true` |
| 8 | Cognee graph citations typed `org`, bypassing persona conversation exclusion (`MEM-S08`) | P2 | `memory/cognee-client.ts`, `memory/retrieve.ts` `filterCitationsForPersona` | 🟢 | `graph` tier; customer/ops/growth/marketing exclude it. Unit test |
| 9 | Inbound messages embedded org-wide with no policy gate; parent retrieve runs before routing without role; Customer can cite other customers' threads (`MEM-S02`, `MEM-B07`) | P0 | `activities/index.ts` `enqueueEmbedActivity`; `WorkItemWorkflow.ts`; `memory/retrieve.ts`; `ask-ai/route.ts` | 🟢 | Policy gate; route-then-retrieve under `patched()`; customer `thread_only` SQL; Ask AI passes employee/role. Unit tests, not run against live DB/Temporal |

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **Multi-Tier Unified Memory Aggregation**:
   - `apps/dashboard/app/api/brain/route.ts:327-355` — `GET /api/brain`:
     - Calls `loadBrain()` (`route.ts:187-281`), performing structured SQL queries across all four tiers (`org_memory`, `employee_memory`, `entity_memory`, `conversation_memory`) under strict RLS session scoping.
     - Dynamically calculates memory staleness based on `MEMORY_STALE_AFTER_DAYS` (`route.ts:141`).
     - Actively filters out memory snippets associated with disabled knowledge sources (`DISABLED_SOURCE_SQL`, lines 114-122).
2. **Role-Gated Memory Mutations**:
   - `apps/dashboard/app/api/brain/route.ts:100-112` and `apps/dashboard/app/api/brain/[id]/route.ts:85-87`:
     - `canMutateBrain` restricts memory edits, deletions, and source imports to `owner` and `admin` roles, returning explicit `403 Forbidden` for standard members.
3. **Granular Multi-Tier Correction**:
   - `apps/dashboard/app/api/brain/[id]/route.ts:91-122` — `PATCH /api/brain/[id]`:
     - Resolves the correct underlying table via `tableForTier`, updates both `body` and `summary` where applicable, and enforces tenant scoping `WHERE id = $1 AND org_id = $2`.
4. **Privacy-Aware Embedding Queue**:
   - `apps/dashboard/lib/embed-enqueue.ts:61-135`:
     - Hashes text with SHA-256 (`hashEmbedContent`), skipping embedding if the hash matches existing database vectors (`skipReason: 'hash'`).
     - Calls `redactForEmbed` to strip PII before queuing asynchronous Temporal `EmbedWorkflow` jobs, adhering to standing architecture rules against awaiting models inline.
5. **pgvector Vector Infrastructure Exists**:
   - `services/workflows/src/memory/retrieve.ts:220-342`:
     - Features real pgvector cosine-similarity SQL queries (`em.embedding <=> $3::vector`) with hybrid full-text search fallbacks.
6. **Connection Pool Safety**:
   - `apps/dashboard/app/api/brain/route.ts:353, 388`:
     - Releases checked-out database clients immediately in `finally` blocks, preventing connection pool exhaustion during memory loading.
7. **Multi-Tier Memory Isolation**:
   - `infra/db/migrations/005_brain.sql:45-120`:
     - Enforces foreign keys and tenant RLS across `org_memory`, `employee_memory`, `entity_memory`, and `conversation_memory`.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Brain UI Search Divergence: Keyword-Only Search Ignores Vector Embeddings (`apps/dashboard/app/api/brain/route.ts:124-185`) (P0)**:
   - *User Impact*: Operators search for concepts (e.g. "cancellation policy") and get zero results because the document uses the words "termination rules", even though semantic vectors exist in PostgreSQL.
   - *Code Cause*: While the Ask AI agent uses `pgvector` cosine similarity (`retrieve.ts`), the Brain search endpoint only executes PostgreSQL full-text search:
     ```sql
     WHERE to_tsvector('english', body) @@ plainto_tsquery('english', $2)
     ```
2. **Orphaned Vector Embeddings on Document Deletion (P0)**:
   - *User Impact*: Ghost knowledge. Deleted documents continue to be cited by AI employees in customer chats.
   - *Code Cause*: `DELETE FROM org_memory WHERE id = $1` does not cascade to `memory_embeddings` because the foreign key lacks `ON DELETE CASCADE`. The vector chunks remain indexed in `memory_embeddings` forever.
3. **Three Divergent Reindex Implementations (Two Dead Code) (`route.ts:357-391`, `[id]/route.ts:189-249`, `reindex/route.ts:144-317`) (P1)**:
   - *User Impact*: Maintenance confusion and inconsistent synchronization behavior.
   - *Code Cause*: Three independent endpoints implement reindexing. The UI calls the basic `POST /api/brain` route, while the full Google Drive/Notion sync workflow in `/api/brain/reindex` is completely unreferenced by the frontend.
4. **Destructive In-Place Memory Overwrite (No Revision History) (`apps/dashboard/app/api/brain/[id]/route.ts:111-116`) (P1)**:
   - *User Impact*: Permanent loss of business rules. If an operator accidentally edits or deletes an important policy, there is no history to recover previous wording.
   - *Code Cause*: `PATCH /api/brain/[id]` executes a direct `UPDATE org_memory SET body = $1` with no prior snapshot saved to a revisions table.
5. **Blind Character Slicing in Text Chunker (`apps/dashboard/lib/embed-enqueue.ts:85-110`)**:
   - *User Impact*: Degraded retrieval quality. Sentences and markdown tables are severed halfway through.
   - *Code Cause*: Chunker slices text strictly every 1,000 characters without respecting sentence periods, markdown headers, or paragraph double newlines.
6. **Sequential Single-Chunk Embedding Network Bottleneck**:
   - *User Impact*: Minutes-long ingestion delays on 20-page handbooks.
   - *Code Cause*: Chunks are embedded one by one in serial HTTP calls rather than batching 32 or 64 chunks per LiteLLM request.
7. **Reindex Button Race Conditions on Frontend (`SourceRow.tsx:26`)**:
   - *User Impact*: Duplicate jobs and wasted OpenAI credits.
   - *Code Cause*: Rapid clicking on "Reindex" triggers parallel requests without client-side debouncing or database-level lock guards.
8. **Missing Document Uploader for PDF, DOCX, and XLSX Files**:
   - *User Impact*: High friction. Admins cannot upload company policy PDFs directly and are forced to manually copy-paste raw text into textareas.
   - *Code Cause*: The UI only accepts pasted strings and lacks a file parsing endpoint.
9. **Unresolved Contradictory Memory Deadlocks**:
   - *User Impact*: AI employees hallucinate conflicting answers when two documents disagree on policy.
   - *Code Cause*: Memory retrieval returns both chunks with high similarity without an arbitrator or recency tie-breaker.
10. **Cross-Tenant Vector Distance Leakage Risk**:
    - *User Impact*: Potential privacy risk in shared database clusters.
    - *Code Cause*: If vector queries join `memory_embeddings` without verifying `e.org_id = current_setting('app.current_org_id', true)::uuid`, nearest neighbor scans can evaluate chunks from foreign tenants.
11. **Stale Memories Flagged Without Auto-Sync Workflow**:
    - *User Impact*: Documents remain permanently flagged "stale" without an automatic sync option.
    - *Code Cause*: The 30-day stale calculation is visual only; no background workflow checks the original external source.
12. **Lack of Entity Knowledge Graph Visualization**:
    - *User Impact*: Operators cannot visualize customer relationship facts stored in `entity_memory`.
    - *Code Cause*: Facts are rendered as plain unlinked table rows.
13. **Desynchronized Semantic Vectors Due to Missing `enqueueEmbedJob` on Document Correction (`apps/dashboard/app/api/brain/[id]/route.ts:91-122`) (P0)**:
    - *User Impact*: Permanent index divergence. When an admin edits or corrects a company policy in `/brain` (e.g. changing refund percentage from 50% to 100%), the AI employee continues retrieving and quoting the old policy because vector embeddings are never updated.
    - *Code Cause*: While `enqueueEmbedJob` is imported at line 5, `PATCH /api/brain/[id]` only executes an SQL `UPDATE ${table} SET body = $3, updated_at = NOW()`. It never enqueues an embedding re-indexing job for the modified content!
    - *Fix*: After updating the document row in PostgreSQL, call `enqueueEmbedJob({ orgId, source: parsed.kind, sourceRef: parsed.id, text: nextBody })`.
14. **Lack of Manual Knowledge Snippet Creation Endpoint (`apps/dashboard/app/api/brain/route.ts:357-380`) (P1)**:
    - *User Impact*: Administrators cannot create custom SOPs or knowledge guidelines directly within the dashboard.
    - *Code Cause*: `POST /api/brain` strictly supports `action === 'reindex'`, returning `400 Unknown action` for anything else. There is no `create` action to insert a new row into `org_memory`.

---

## What's missing vs full vision

1. **Hybrid Vector & Keyword Search Engine (RRF)**:
   - Combining BM25 keyword rank and `pgvector` cosine similarity using Reciprocal Rank Fusion, ensuring both exact keyword hits and semantic concepts are surfaced in the Brain UI.
2. **Memory Revision History & Rollback Console**:
   - Dedicated table `memory_revisions` capturing every edit with user attribution and a 1-click "Revert to Version" button.
3. **Multi-Format Document Ingestion Dropzone**:
   - Drag-and-drop file uploader supporting `.pdf`, `.docx`, `.txt`, and `.md` files with automated text extraction and semantic chunking.
4. **Sentence-Aware Semantic Text Chunker**:
   - Chunker splitting text along markdown headers, paragraphs, and sentence boundaries to preserve coherent thought units.
5. **Cascading Foreign Key Vector Cleanup**:
   - Database constraint guaranteeing that deleting a memory item automatically deletes its associated vector chunks.
6. **Automated Weekly Memory Freshness Sweep**:
   - Background Temporal cron workflow re-verifying external Google Drive/Notion sources and updating embeddings.
7. **Interactive Knowledge Graph Viewer**:
   - Visual graph explorer displaying connections between properties, contacts, and corporate policies.
8. **Citation Attribution in Chat Drawer**:
   - Interactive badge on AI responses showing the exact memory title and paragraph that influenced the answer.

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Revisions & Vector Cascades (`048_brain_revisions_and_cascades.sql`)
```sql
-- 1. Table for memory revision history and audit rollback
CREATE TABLE IF NOT EXISTS memory_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  memory_id UUID NOT NULL,
  tier TEXT NOT NULL,
  previous_title TEXT,
  previous_body TEXT NOT NULL,
  changed_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_revisions_lookup
  ON memory_revisions (org_id, memory_id, created_at DESC);

ALTER TABLE memory_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY memory_revisions_isolation ON memory_revisions
  FOR ALL USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- 2. Cascading delete from org_memory to memory_embeddings
ALTER TABLE memory_embeddings DROP CONSTRAINT IF EXISTS fk_memory_id;
ALTER TABLE memory_embeddings
  ADD CONSTRAINT fk_memory_id
  FOREIGN KEY (memory_id) REFERENCES org_memory(id) ON DELETE CASCADE;

-- 3. Document attachments and access levels
ALTER TABLE org_memory
  ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'all' CHECK (access_level IN ('all', 'internal_only', 'executive_only')),
  ADD COLUMN IF NOT EXISTS source_file_url TEXT,
  ADD COLUMN IF NOT EXISTS source_file_type TEXT;
```

### 2. Hybrid Vector + BM25 Search Implementation (`apps/dashboard/lib/brain-search.ts`)
```typescript
import { PoolClient } from 'pg';
import { generateEmbedding } from '@/lib/embeddings';

export async function hybridSearchBrain(client: PoolClient, orgId: string, query: string) {
  // 1. Generate semantic embedding vector for search phrase
  const queryEmbedding = await generateEmbedding(query);
  const vectorStr = `[${queryEmbedding.join(',')}]`;

  // 2. Hybrid query blending Full-Text BM25 score and Cosine similarity
  const res = await client.query(
    `SELECT m.id, m.title, m.body, m.tier, m.source, m.updated_at, m.access_level,
            (
              COALESCE(ts_rank_cd(to_tsvector('english', m.body), plainto_tsquery('english', $2)), 0) * 0.4 +
              COALESCE(1 - (e.embedding <=> $3::vector), 0) * 0.6
            ) AS hybrid_score
     FROM org_memory m
     LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.org_id = m.org_id
     WHERE m.org_id = $1
       AND (
         to_tsvector('english', m.body) @@ plainto_tsquery('english', $2)
         OR (e.embedding <=> $3::vector) < 0.45
       )
     ORDER BY hybrid_score DESC
     LIMIT 25`,
    [orgId, query, vectorStr]
  );

  return res.rows;
}
```

### 3. Memory Revision & Rollback Route (`apps/dashboard/app/api/brain/[id]/revisions/route.ts`)
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole } from '@/lib/rbac';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { client, orgId } = await getScopedClient();
  try {
    const res = await client.query(
      `SELECT r.id, r.previous_title, r.previous_body, r.created_at, u.name as changed_by
       FROM memory_revisions r
       LEFT JOIN users u ON u.id = r.changed_by_user_id
       WHERE r.memory_id = $1 AND r.org_id = $2
       ORDER BY r.created_at DESC`,
      [params.id, orgId]
    );

    return NextResponse.json({ revisions: res.rows });
  } finally {
    client.release();
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json({ error: 'Admin role required to rollback memories' }, { status: 403 });
    }

    const { revisionId } = await req.json();

    // Fetch snapshot
    const revRes = await client.query(
      `SELECT previous_title, previous_body FROM memory_revisions WHERE id = $1 AND memory_id = $2 AND org_id = $3`,
      [revisionId, params.id, orgId]
    );

    if (revRes.rowCount === 0) {
      return NextResponse.json({ error: 'Revision not found' }, { status: 404 });
    }

    const { previous_title, previous_body } = revRes.rows[0];

    // Revert memory
    await client.query(
      `UPDATE org_memory
       SET title = $1, body = $2, updated_at = NOW()
       WHERE id = $3 AND org_id = $4`,
      [previous_title, previous_body, params.id, orgId]
    );

    return NextResponse.json({ success: true, message: 'Memory reverted to revision' });
  } finally {
    client.release();
  }
}
```

### 4. Interactive Brain Explorer UI (`apps/dashboard/app/(dashboard)/brain/page.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import {
  Brain,
  Search,
  UploadCloud,
  FileText,
  RotateCcw,
  Sparkles,
  CheckCircle2,
  Clock,
  Trash2,
  ShieldAlert
} from 'lucide-react';
import { toast } from 'sonner';

interface MemoryItem {
  id: string;
  title: string;
  body: string;
  tier: string;
  source: string;
  updated_at: string;
  hybrid_score?: number;
}

export default function BrainDashboardPage() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchMemories = async (query = '') => {
    setLoading(true);
    try {
      const url = query ? `/api/brain?q=${encodeURIComponent(query)}` : '/api/brain';
      const res = await fetch(url);
      const data = await res.json();
      setMemories(data.memories || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMemories();
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    fetchMemories(searchQuery);
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between pb-6 border-b border-slate-800">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Brain className="w-6 h-6 text-emerald-400" />
            The Brain: Organizational Knowledge Base
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Standard operating procedures, business rules, and entity memory grounded in pgvector.
          </p>
        </div>

        <button
          onClick={() => toast.info('Open Document Upload Modal')}
          className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-sm transition"
        >
          <UploadCloud className="w-3.5 h-3.5" /> Upload Document (PDF/DOCX)
        </button>
      </div>

      {/* Semantic Search Bar */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search concepts or exact keywords across all memory tiers (hybrid vector search)..."
            className="w-full pl-10 pr-4 py-2.5 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
          />
        </div>
        <button
          type="submit"
          className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition"
        >
          Search Knowledge
        </button>
      </form>

      {/* Memory Items Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {memories.map((m) => (
          <div
            key={m.id}
            className="p-5 bg-slate-900 border border-slate-800 rounded-xl flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  {m.tier} tier
                </span>
                <span className="text-[10px] text-slate-500 font-mono">
                  Source: {m.source}
                </span>
              </div>

              <h3 className="text-base font-semibold text-slate-100 mt-2">{m.title}</h3>
              <p className="text-xs text-slate-300 mt-2 line-clamp-3 leading-relaxed">{m.body}</p>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between text-xs">
              <span className="text-slate-500">
                Updated {new Date(m.updated_at).toLocaleDateString()}
              </span>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => toast.info(`Viewing revision history for ${m.id}`)}
                  className="flex items-center gap-1 text-slate-400 hover:text-slate-200"
                >
                  <RotateCcw className="w-3 h-3" /> Revisions
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## Fix priority

- **P0**: Call `enqueueEmbedJob` on document correction (`PATCH /api/brain/[id]`) to prevent permanent vector divergence where the vector index permanently retains obsolete text.
- **P0**: Implement hybrid vector search in `GET /api/brain` so UI searches match the semantic power of the agent runtime.
- **P0**: Add cascading delete from `org_memory` to `memory_embeddings` to eliminate phantom vector retrieval of deleted documents.
- **P1**: Add manual memory snippet creation action (`action: 'create'`) in `POST /api/brain` to allow direct admin entry of SOPs.
- **P1**: Consolidate the 3 duplicate reindex routes into a single canonical Temporal sync pipeline.
- **P1**: Add revision history table (`memory_revisions`) to prevent accidental destruction of corporate SOPs.
- **P1**: Implement sentence-aware semantic text chunking in `embed-enqueue.ts` instead of blind character slicing.
- **P2**: Build document source import modal in the Brain UI for PDF/DOCX and Google Drive.
- **P2**: Implement automated weekly memory freshness sweep via Temporal cron.
