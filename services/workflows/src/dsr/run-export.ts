import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { PoolClient } from 'pg';
import { exportHindsight, hindsightEnabled } from '../memory/hindsight-client.js';
import { cogneeEnabled, exportCognee } from '../memory/cognee-client.js';

async function selectRows(
  client: PoolClient,
  sql: string,
  orgId: string
): Promise<Record<string, unknown>[]> {
  const res = await client.query(sql, [orgId]);
  return res.rows as Record<string, unknown>[];
}

export function dsrArtifactRoot(): string {
  const fromEnv = process.env.DSR_ARTIFACT_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.tmpdir(), 'darex-dsr');
}

/** Org-scoped relative path stored on dsr_requests.artifact_path. */
export function dsrArtifactRelPath(orgId: string, dsrRequestId: string): string {
  return path.join(orgId, `${dsrRequestId}.json`);
}

export function dsrArtifactAbsPath(orgId: string, dsrRequestId: string): string {
  return path.join(dsrArtifactRoot(), dsrArtifactRelPath(orgId, dsrRequestId));
}

async function writeExportAudit(
  client: PoolClient,
  orgId: string,
  userId: string | null,
  dsrRequestId: string
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO audit_events (
         org_id, kind, actor_type, actor_user_id, result_status, payload
       ) VALUES ($1, 'dsr.export', 'user', $2, 'ok', $3::jsonb)`,
      [orgId, userId, JSON.stringify({ dsrRequestId })]
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/audit_events|kind_chk|does not exist/i.test(message)) {
      console.warn('[dsr] audit_events write skipped:', message.slice(0, 120));
      return;
    }
    throw err;
  }
}

export type RunDsrExportResult = {
  dsrRequestId: string;
  status: 'completed';
  artifactPath: string;
  downloadPath: string;
  counts: Record<string, number>;
};

/**
 * Builds the org export payload, writes a downloadable JSON artifact under
 * DSR_ARTIFACT_DIR/{orgId}/{dsrRequestId}.json, and records honest metadata
 * (knowledge_sources paths only — no third-party file bytes). Transient
 * errors rethrow so Temporal can retry; permanent failure is marked by
 * markDsrRequestFailed after retries are exhausted.
 */
export async function runDsrExport(
  client: PoolClient,
  params: { orgId: string; dsrRequestId: string; requestedByUserId: string | null }
): Promise<RunDsrExportResult> {
  const { orgId, dsrRequestId, requestedByUserId } = params;

  await client.query(
    `UPDATE dsr_requests
        SET status = 'running', progress = $3::jsonb, completed_at = NULL, error = NULL
      WHERE id = $1 AND org_id = $2`,
    [dsrRequestId, orgId, JSON.stringify({ phase: 'collecting' })]
  );

  const org =
    (
      await selectRows(
        client,
        `SELECT id, name, slug, plan, status, created_at FROM orgs WHERE id = $1`,
        orgId
      )
    )[0] || null;
  const users = await selectRows(
    client,
    `SELECT id, org_id, email, role, created_at FROM users WHERE org_id = $1`,
    orgId
  );
  const employees = await selectRows(
    client,
    `SELECT id, name, role, status, created_at FROM ai_employees WHERE org_id = $1`,
    orgId
  );
  const channels = await selectRows(
    client,
    `SELECT id, channel_type, status, created_at FROM channels WHERE org_id = $1`,
    orgId
  );
  const conversations = await selectRows(
    client,
    `SELECT id, contact_id, status, channel_id, created_at, updated_at FROM conversations WHERE org_id = $1`,
    orgId
  );
  const messages = await selectRows(
    client,
    `SELECT id, conversation_id, role, content, created_at FROM messages WHERE org_id = $1 ORDER BY created_at ASC`,
    orgId
  );
  const orgMemory = await selectRows(
    client,
    `SELECT id, kind, title, body, source, source_ref, content_hash,
            (embedding IS NOT NULL) AS has_embedding, created_at, updated_at
       FROM org_memory WHERE org_id = $1`,
    orgId
  );
  const employeeMemory = await selectRows(
    client,
    `SELECT id, employee_id, kind, title, body, source, source_ref,
            (embedding IS NOT NULL) AS has_embedding, created_at
       FROM employee_memory WHERE org_id = $1`,
    orgId
  );
  const entityMemory = await selectRows(
    client,
    `SELECT id, entity_type, entity_id, kind, title, body,
            (embedding IS NOT NULL) AS has_embedding, created_at
       FROM entity_memory WHERE org_id = $1`,
    orgId
  );
  const conversationMemory = await selectRows(
    client,
    `SELECT id, conversation_id, kind, title, body,
            (embedding IS NOT NULL) AS has_embedding, created_at
       FROM conversation_memory WHERE org_id = $1`,
    orgId
  );
  const memoryEdges = await selectRows(
    client,
    `SELECT id, from_id, to_id, from_kind, to_kind, rel FROM memory_edges WHERE org_id = $1`,
    orgId
  );
  let facts: Record<string, unknown>[] = [];
  let factConflicts: Record<string, unknown>[] = [];
  try {
    facts = await selectRows(
      client,
      `SELECT id, subject_id, predicate, object_type, object_text, object_number,
              object_money_minor, object_currency, object_date, object_bool,
              confidence, status, source_kind, created_at
         FROM facts WHERE org_id = $1`,
      orgId
    );
    factConflicts = await selectRows(
      client,
      `SELECT id, subject_id, predicate, fact_a, fact_b, resolution, work_item_id, created_at
         FROM fact_conflicts WHERE org_id = $1`,
      orgId
    );
  } catch (err: unknown) {
    if ((err as { code?: string })?.code !== '42P01') throw err;
  }
  // Honest: metadata only — knowledge_sources point at external connectors.
  const files = await selectRows(
    client,
    `SELECT id, connector, path, status, last_synced AS last_synced, created_at
       FROM knowledge_sources WHERE org_id = $1`,
    orgId
  );
  const workItems = await selectRows(
    client,
    `SELECT id, type, status, conversation_id, created_at FROM work_items WHERE org_id = $1`,
    orgId
  );
  const plans = await selectRows(
    client,
    `SELECT id, summary, status, created_at FROM agent_plans WHERE org_id = $1`,
    orgId
  );

  // Extracted facts held in Hindsight. A failed fetch is recorded in the file,
  // never silently dropped, so the export cannot look complete when it is not.
  let hindsight: { facts: Record<string, unknown>[]; error?: string } | null = null;
  if (hindsightEnabled()) {
    try {
      hindsight = { facts: await exportHindsight(orgId) };
    } catch (err: unknown) {
      hindsight = { facts: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Source records behind the Cognee graph; a failed fetch is recorded, not dropped.
  let cognee: { records: Record<string, unknown>[]; error?: string } | null = null;
  if (cogneeEnabled()) {
    try {
      cognee = { records: await exportCognee(orgId) };
    } catch (err: unknown) {
      cognee = { records: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  const exportPayload = {
    org,
    users,
    employees,
    channels,
    conversations,
    messages,
    memory: {
      org: orgMemory,
      employee: employeeMemory,
      entity: entityMemory,
      conversation: conversationMemory,
      edges: memoryEdges,
      facts,
      factConflicts,
      hindsight,
      cognee,
    },
    files,
    filesNote:
      'files contains knowledge_sources metadata only (connector + path). Third-party file bytes are not hosted by Darex.',
    includeFiles: false,
    workItems,
    plans,
    exportedAt: new Date().toISOString(),
  };

  const relPath = dsrArtifactRelPath(orgId, dsrRequestId);
  const absPath = dsrArtifactAbsPath(orgId, dsrRequestId);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, JSON.stringify(exportPayload, null, 2), 'utf8');

  const counts = {
    users: users.length,
    conversations: conversations.length,
    messages: messages.length,
    memory:
      orgMemory.length +
      employeeMemory.length +
      entityMemory.length +
      conversationMemory.length +
      (hindsight?.facts.length ?? 0) +
      (cognee?.records.length ?? 0),
    files: files.length,
  };

  await client.query(
    `UPDATE dsr_requests
        SET status = 'completed',
            completed_at = NOW(),
            artifact_path = $3,
            progress = $4::jsonb,
            result = $5::jsonb,
            error = NULL,
            include_files = false
      WHERE id = $1 AND org_id = $2`,
    [
      dsrRequestId,
      orgId,
      relPath,
      JSON.stringify({ phase: 'written' }),
      JSON.stringify({ counts, includeFiles: false }),
    ]
  );

  await writeExportAudit(client, orgId, requestedByUserId, dsrRequestId);

  return {
    dsrRequestId,
    status: 'completed',
    artifactPath: relPath,
    downloadPath: `/api/dsr/${dsrRequestId}/download`,
    counts,
  };
}
