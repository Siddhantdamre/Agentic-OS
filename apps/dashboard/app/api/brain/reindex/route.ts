import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { getTemporalClient } from '@darex/workflows/dist/workflow-client';

export const dynamic = 'force-dynamic';

type ReindexConnector = 'drive' | 'upload' | 'google-drive' | 'google-sheets' | 'hubspot';

function isAlreadyStarted(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { name?: string; message?: string };
  if (rec.name === 'WorkflowExecutionAlreadyStartedError') return true;
  return /already (started|running)/i.test(String(rec.message || ''));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeConnector(raw: unknown): ReindexConnector {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  switch (value) {
    case 'drive':
    case 'google-drive':
      return 'google-drive';
    case 'google-sheets':
      return 'google-sheets';
    case 'hubspot':
      return 'hubspot';
    case 'upload':
    default:
      return 'upload';
  }
}

function knowledgeConnector(connector: ReindexConnector): string {
  switch (connector) {
    case 'drive':
    case 'google-drive':
      return 'drive';
    case 'upload':
      return 'upload';
    case 'google-sheets':
      return 'sheets';
    case 'hubspot':
      return 'crm';
    default: {
      const _exhaustive: never = connector;
      return _exhaustive;
    }
  }
}

async function driveConnected(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  orgId: string,
): Promise<boolean> {
  const chan = await client.query(
    `SELECT 1 FROM channels
      WHERE org_id = $1 AND channel_type IN ('google-drive', 'google')
        AND status IN ('connected', 'active')
      LIMIT 1`,
    [orgId],
  );
  if (chan.rows[0]) return true;
  try {
    const orgc = await client.query(
      `SELECT 1 FROM org_connectors
        WHERE org_id = $1 AND connector_key = 'google-drive' AND status = 'connected'
        LIMIT 1`,
      [orgId],
    );
    return Boolean(orgc.rows[0]);
  } catch {
    return false;
  }
}

function notConnectedBody(tool: string) {
  return {
    status: 'error',
    connected: false,
    setupUrl: '/connectors',
    message: `${tool} not connected. Authorize via Nango OAuth at /connectors to enable real actions.`,
  };
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const res = await client.query(
        `SELECT ks.id, ks.connector, ks.path, ks.content_hash, ks.last_synced, ks.status, ks.metadata, ks.updated_at,
                (
                  SELECT ij.state FROM ingestion_jobs ij
                   WHERE ij.org_id = ks.org_id AND ij.source_id = ks.id
                   ORDER BY ij.created_at DESC LIMIT 1
                ) AS job_state,
                (
                  SELECT ij.error FROM ingestion_jobs ij
                   WHERE ij.org_id = ks.org_id AND ij.source_id = ks.id
                   ORDER BY ij.created_at DESC LIMIT 1
                ) AS job_error
           FROM knowledge_sources ks
          WHERE ks.org_id = $1
          ORDER BY ks.updated_at DESC
          LIMIT 100`,
        [orgId],
      );
      const sources = res.rows.map((row) => {
        const metadata = asRecord(row.metadata);
        const modifiedAt =
          (typeof metadata.modifiedAt === 'string' && metadata.modifiedAt)
          || (row.last_synced ? String(row.last_synced) : null)
          || (row.updated_at ? String(row.updated_at) : null);
        const status = String(row.status || 'pending');
        const pending = status === 'pending' || status === 'syncing' || row.job_state === 'queued' || row.job_state === 'running';
        return {
          id: String(row.id),
          connector: String(row.connector),
          path: String(row.path),
          modified_at: modifiedAt,
          status,
          pending,
          last_error: typeof metadata.last_error === 'string' ? metadata.last_error : (row.job_error ? String(row.job_error) : null),
        };
      });
      return NextResponse.json({ orgId, sources });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API GET /api/brain/reindex Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = asRecord(await request.json().catch(() => ({})));
    // Never trust body.org_id / body.orgId — session RLS only.
    void body.org_id;
    void body.orgId;

    const { client, orgId } = await getScopedClient();
    const connector = normalizeConnector(body.connector);
    const syncRequested = body.sync === true || connector === 'google-sheets' || connector === 'hubspot'
      || (connector === 'google-drive' && !body.fileId && !body.path && !body.sourceId);

    let sourceId: string | undefined;
    let jobId: string | undefined;
    let path = typeof body.path === 'string' ? body.path.trim() : '';
    let modifiedAt = typeof body.modifiedAt === 'string' ? body.modifiedAt : null;

    try {
      if (connector === 'google-drive' || connector === 'drive') {
        const ok = await driveConnected(client, orgId);
        if (!ok) {
          return NextResponse.json(notConnectedBody('google-drive'), { status: 409 });
        }
      }

      if (!syncRequested) {
        const fileId = typeof body.fileId === 'string' ? body.fileId.trim() : '';
        const mimeType = typeof body.mimeType === 'string' ? body.mimeType.trim() : '';
        const kind = typeof body.kind === 'string' ? body.kind : null;
        const dataClass = typeof body.dataClass === 'string' ? body.dataClass : null;
        const content = typeof body.content === 'string' ? body.content : '';
        const ingestBase64 = typeof body.ingestBase64 === 'string' ? body.ingestBase64 : '';
        path = path || (fileId ? `drive:${fileId}` : '') || (typeof body.sourceId === 'string' ? '' : `upload:${Date.now()}`);

        if (typeof body.sourceId === 'string' && body.sourceId.trim()) {
          sourceId = body.sourceId.trim();
          const existing = await client.query(
            `SELECT id, path, metadata FROM knowledge_sources WHERE id = $1 AND org_id = $2 LIMIT 1`,
            [sourceId, orgId],
          );
          if (!existing.rows[0]) {
            return NextResponse.json({ error: 'knowledge source not found' }, { status: 404 });
          }
          path = String(existing.rows[0].path);
          const meta = asRecord(existing.rows[0].metadata);
          if (typeof meta.modifiedAt === 'string') modifiedAt = meta.modifiedAt;
        } else {
          const catalogConnector = knowledgeConnector(connector);
          const inserted = await client.query(
            `INSERT INTO knowledge_sources (org_id, connector, path, status, metadata)
             VALUES ($1, $2, $3, 'pending', $4::jsonb)
             ON CONFLICT (org_id, connector, path)
             DO UPDATE SET
               status = 'pending',
               metadata = knowledge_sources.metadata || EXCLUDED.metadata,
               updated_at = NOW()
             RETURNING id`,
            [
              orgId,
              catalogConnector,
              path,
              JSON.stringify({
                fileId: fileId || null,
                mimeType: mimeType || null,
                kind,
                dataClass,
                modifiedAt,
                ingestText: content || null,
                ingestBase64: ingestBase64 || null,
                last_error: null,
              }),
            ],
          );
          sourceId = String(inserted.rows[0].id);
        }

        const job = await client.query(
          `INSERT INTO ingestion_jobs (org_id, source_id, state)
           VALUES ($1, $2, 'queued')
           RETURNING id`,
          [orgId, sourceId],
        );
        jobId = String(job.rows[0].id);
      }
    } finally {
      client.release();
    }

    const temporal = await getTemporalClient();
    if (!temporal) {
      return NextResponse.json({
        orgId,
        sourceId,
        jobId,
        path: path || null,
        modified_at: modifiedAt,
        status: 'pending',
        pending: true,
        message: 'Job queued. Temporal is unavailable so ingest has not started yet.',
      });
    }

    if (syncRequested) {
      const connectorKey = connector === 'upload' ? 'google-drive' : connector;
      const stream = typeof body.stream === 'string' && body.stream.trim() ? body.stream.trim() : 'files';
      const workflowId = `sync-${orgId}-${connectorKey}-${stream}`;
      try {
        await temporal.workflow.start('SyncWorkflow', {
          taskQueue: 'darex-agent-tasks',
          workflowId,
          args: [{ orgId, connectorKey, stream }],
          workflowExecutionTimeout: '30 minutes',
        });
      } catch (err: unknown) {
        if (!isAlreadyStarted(err)) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[brain/reindex] SyncWorkflow start failed: ${message}`);
        }
      }
      return NextResponse.json({
        orgId,
        status: 'pending',
        pending: true,
        sync: true,
        connector: connectorKey,
        stream,
        message: 'Sync enqueued. Sources stay pending until ingest finishes.',
      });
    }

    const workflowId = `ingest-${orgId}-${sourceId}`;
    try {
      await temporal.workflow.start('IngestWorkflow', {
        taskQueue: 'darex-agent-tasks',
        workflowId,
        args: [{
          orgId,
          sourceId,
          jobId,
          connector,
          path,
          fileId: typeof body.fileId === 'string' ? body.fileId : undefined,
          mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
          kind: typeof body.kind === 'string' ? body.kind : undefined,
          dataClass: typeof body.dataClass === 'string' ? body.dataClass : undefined,
          modifiedAt,
        }],
        workflowExecutionTimeout: '30 minutes',
      });
    } catch (err: unknown) {
      if (!isAlreadyStarted(err)) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[brain/reindex] IngestWorkflow start failed: ${message}`);
      }
    }

    return NextResponse.json({
      orgId,
      sourceId,
      jobId,
      path,
      modified_at: modifiedAt,
      status: 'pending',
      pending: true,
      message: 'Ingest enqueued. SOP is retrievable with path + modified_at once embedded, or stays pending.',
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('API POST /api/brain/reindex Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
