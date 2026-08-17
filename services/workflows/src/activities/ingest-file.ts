import { createHash } from 'crypto';
import { ApplicationFailure } from '@temporalio/activity';
import type { PoolClient } from 'pg';
import { enqueueEmbedJobFromWorker } from './embed.js';
import { redactErrorMessage, redactForEmbed } from './redact.js';
import {
  fetchWithTimeout,
  getNangoAccessToken,
  withOrgScopedClient,
} from '../tools/shared.js';

const KYC_KIND = new Set(['kyc', 'pan', 'aadhaar', 'passport', 'gov_id', 'government_id']);
const KYC_PATH = /(?:^|\/)(kyc|aadhaar|pan|passport|gov[_-]?id)(?:\/|\.|$)/i;
const TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'application/xml',
  'text/xml',
]);
const MIN_CHUNK_TOKENS = 512;
const MAX_CHUNK_TOKENS = 1024;
const OVERLAP_RATIO = 0.15;
const MAX_DRIVE_PAGES = 10;
const MAX_DRIVE_FILES = 50;

export type IngestConnector = 'drive' | 'upload' | 'google-drive';
export type IngestSkipReason = 'kyc' | 'empty' | 'hash' | 'virus' | 'parse' | 'not_connected';
export type IngestWorkflowStatus = 'enqueued' | 'skipped' | 'failed' | 'pending';

export interface IngestFileActivityInput {
  orgId: string;
  jobId?: string;
  sourceId?: string;
  connector?: IngestConnector;
  path?: string;
  fileId?: string;
  mimeType?: string;
  kind?: string | null;
  dataClass?: string | null;
  modifiedAt?: string | null;
}

export interface IngestFileActivityResult {
  orgId: string;
  sourceId?: string;
  jobId?: string;
  status: IngestWorkflowStatus;
  skipReason?: IngestSkipReason;
  path?: string;
  modifiedAt?: string;
  chunkCount?: number;
  embedJobs?: string[];
  error?: string;
  connected?: boolean;
  setupUrl?: string;
}

export type SyncConnectorKey = 'google-drive' | 'google-sheets' | 'hubspot';

export interface SyncConnectorActivityInput {
  orgId: string;
  connectorKey: SyncConnectorKey;
  stream: string;
}

export interface PendingIngestItem {
  sourceId: string;
  jobId?: string;
  connector: IngestConnector;
  path: string;
  fileId?: string;
  mimeType?: string;
  kind?: string | null;
  modifiedAt?: string | null;
}

export interface SyncConnectorActivityResult {
  status: 'listed' | 'not_connected' | 'failed';
  upserted: number;
  skipped: number;
  conflicts: number;
  cursor?: string | null;
  pendingIngest: PendingIngestItem[];
  error?: string;
  connected?: boolean;
  setupUrl?: string;
}

type VirusScanResult =
  | { clean: true; scanner: 'stub' }
  | { clean: false; scanner: 'stub'; reason: string };

type ParseResult =
  | { ok: true; text: string; parser: 'docling' | 'text' }
  | { ok: false; reason: 'unavailable' | 'error'; message: string };

interface SourceRow {
  id: string;
  connector: string;
  path: string;
  content_hash: string | null;
  status: string;
  metadata: Record<string, unknown>;
  last_synced: string | null;
}

interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  md5Checksum?: string;
}

function requireOrgId(orgId: string | undefined): string {
  if (!orgId) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function isKyc(kind: string | null | undefined, dataClass: string | null | undefined, path: string): boolean {
  if (kind && KYC_KIND.has(kind.trim().toLowerCase())) return true;
  if ((dataClass || '').trim().toLowerCase() === 'kyc_pointer') return true;
  return KYC_PATH.test(path);
}

function normalizeConnector(raw: string | undefined): IngestConnector {
  const value = (raw || 'upload').trim().toLowerCase();
  switch (value) {
    case 'drive':
    case 'google-drive':
      return 'google-drive';
    case 'upload':
      return 'upload';
    default:
      return 'upload';
  }
}

function memorySourceFor(connector: IngestConnector): 'drive' | 'upload' {
  switch (connector) {
    case 'drive':
    case 'google-drive':
      return 'drive';
    case 'upload':
      return 'upload';
    default: {
      const _exhaustive: never = connector;
      return _exhaustive;
    }
  }
}

function knowledgeConnector(connector: IngestConnector): string {
  return memorySourceFor(connector);
}

/** Virus-scan stub (K2). Always clean unless the payload is empty. No third-party retain. */
export function virusScanStub(bytes: Buffer | string): VirusScanResult {
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  if (size <= 0) {
    return { clean: false, scanner: 'stub', reason: 'empty payload' };
  }
  return { clean: true, scanner: 'stub' };
}

function isTableBlock(block: string): boolean {
  const lines = block.split('\n').filter((line) => line.trim());
  if (lines.length < 2) return false;
  return lines.every((line) => line.trim().startsWith('|'));
}

/** Chunk 512–1024 tokens with 15% overlap. Table markdown stays whole. */
export function chunkDocument(text: string): string[] {
  const trimmed = text.replace(/\u0000/g, '').trim();
  if (!trimmed) return [];

  const blocks = trimmed.split(/\n{2,}/);
  const pieces: string[] = [];
  let buffer = '';

  const flush = () => {
    const body = buffer.trim();
    if (body) pieces.push(body);
    buffer = '';
  };

  for (const block of blocks) {
    const candidate = buffer ? `${buffer}\n\n${block}` : block;
    if (isTableBlock(block) && estimateTokens(block) <= MAX_CHUNK_TOKENS * 2) {
      flush();
      pieces.push(block.trim());
      continue;
    }
    if (estimateTokens(candidate) <= MAX_CHUNK_TOKENS) {
      buffer = candidate;
      continue;
    }
    if (estimateTokens(buffer) >= MIN_CHUNK_TOKENS) {
      flush();
      buffer = block;
      continue;
    }
    const words = candidate.split(/\s+/);
    let acc = '';
    for (const word of words) {
      const next = acc ? `${acc} ${word}` : word;
      if (estimateTokens(next) > MAX_CHUNK_TOKENS && acc) {
        pieces.push(acc);
        const overlapChars = Math.floor(MAX_CHUNK_TOKENS * OVERLAP_RATIO) * 4;
        acc = acc.slice(Math.max(0, acc.length - overlapChars)).trim();
        acc = acc ? `${acc} ${word}` : word;
      } else {
        acc = next;
      }
    }
    buffer = acc;
  }
  flush();

  if (pieces.length <= 1) return pieces.filter(Boolean);

  const overlapped: string[] = [];
  for (let i = 0; i < pieces.length; i += 1) {
    if (i === 0) {
      overlapped.push(pieces[i]);
      continue;
    }
    const prev = pieces[i - 1];
    const overlapChars = Math.floor(estimateTokens(prev) * OVERLAP_RATIO) * 4;
    const prefix = prev.slice(Math.max(0, prev.length - overlapChars)).trim();
    overlapped.push(prefix ? `${prefix}\n${pieces[i]}` : pieces[i]);
  }
  return overlapped.filter(Boolean);
}

function looksLikeText(mimeType: string, bytes: Buffer): boolean {
  if (TEXT_MIMES.has(mimeType.split(';')[0].trim().toLowerCase())) return true;
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 800));
  let odd = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) odd += 1;
  }
  return odd / sample.length < 0.1;
}

async function parseWithDocling(bytes: Buffer, fileName: string, mimeType: string): Promise<ParseResult> {
  const base = (process.env.DOCLING_URL || '').trim().replace(/\/$/, '');
  if (!base) {
    return {
      ok: false,
      reason: 'unavailable',
      message: 'Docling parser is not configured (DOCLING_URL). Cannot parse this file type.',
    };
  }
  const url = `${base}/v1/convert/file`;
  try {
    const form = new FormData();
    const blob = new Blob([new Uint8Array(bytes)], { type: mimeType || 'application/octet-stream' });
    form.append('files', blob, fileName || 'document');
    const res = await fetchWithTimeout(url, { method: 'POST', body: form }, 60000);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        reason: 'error',
        message: `Docling HTTP ${res.status}: ${redactErrorMessage(body).slice(0, 180)}`,
      };
    }
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    const document = asRecord(data?.document);
    const md =
      (typeof document.md_content === 'string' && document.md_content)
      || (typeof document.markdown === 'string' && document.markdown)
      || (typeof data?.md_content === 'string' && data.md_content)
      || (typeof data?.text === 'string' && data.text)
      || '';
    if (!md.trim()) {
      return { ok: false, reason: 'error', message: 'Docling returned no extractable text.' };
    }
    return { ok: true, text: md, parser: 'docling' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'error', message: `Docling request failed: ${redactErrorMessage(message)}` };
  }
}

async function parseFile(bytes: Buffer, fileName: string, mimeType: string): Promise<ParseResult> {
  const mime = (mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (looksLikeText(mime, bytes)) {
    return { ok: true, text: bytes.toString('utf8'), parser: 'text' };
  }
  return parseWithDocling(bytes, fileName, mime);
}

async function googleDriveToken(orgId: string): Promise<string | null> {
  const connId = `${orgId}_google-drive`;
  for (const providerKey of ['google-drive', 'google'] as const) {
    const token = await getNangoAccessToken(connId, providerKey);
    if (token) return token;
  }
  return null;
}

async function driveGetMeta(token: string, fileId: string): Promise<DriveFileMeta | null> {
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,md5Checksum`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const data = await res.json() as DriveFileMeta;
  if (!data?.id) return null;
  return data;
}

async function driveDownload(token: string, file: DriveFileMeta): Promise<Buffer> {
  const mime = file.mimeType || '';
  const exportMime = mime === 'application/vnd.google-apps.document' ? 'text/plain'
    : mime === 'application/vnd.google-apps.spreadsheet' ? 'text/csv'
    : mime === 'application/vnd.google-apps.presentation' ? 'text/plain'
    : null;
  const url = exportMime
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }, 60000);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive download HTTP ${res.status}: ${redactErrorMessage(body)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function loadSource(
  client: PoolClient,
  orgId: string,
  sourceId: string | undefined,
  path: string | undefined,
  connector: string,
): Promise<SourceRow | null> {
  if (sourceId) {
    const res = await client.query(
      `SELECT id, connector, path, content_hash, status, metadata, last_synced
         FROM knowledge_sources WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [sourceId, orgId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      connector: String(row.connector),
      path: String(row.path),
      content_hash: row.content_hash ? String(row.content_hash) : null,
      status: String(row.status),
      metadata: asRecord(row.metadata),
      last_synced: row.last_synced ? String(row.last_synced) : null,
    };
  }
  if (path) {
    const res = await client.query(
      `SELECT id, connector, path, content_hash, status, metadata, last_synced
         FROM knowledge_sources WHERE org_id = $1 AND connector = $2 AND path = $3 LIMIT 1`,
      [orgId, connector, path],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      connector: String(row.connector),
      path: String(row.path),
      content_hash: row.content_hash ? String(row.content_hash) : null,
      status: String(row.status),
      metadata: asRecord(row.metadata),
      last_synced: row.last_synced ? String(row.last_synced) : null,
    };
  }
  return null;
}

async function upsertCatalog(params: {
  client: PoolClient;
  orgId: string;
  connector: string;
  path: string;
  contentHash?: string | null;
  status: string;
  metadata: Record<string, unknown>;
}): Promise<string> {
  const res = await params.client.query(
    `INSERT INTO knowledge_sources (org_id, connector, path, content_hash, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (org_id, connector, path)
     DO UPDATE SET
       metadata = knowledge_sources.metadata || EXCLUDED.metadata,
       status = EXCLUDED.status,
       content_hash = COALESCE(EXCLUDED.content_hash, knowledge_sources.content_hash),
       updated_at = NOW()
     RETURNING id`,
    [
      params.orgId,
      params.connector,
      params.path,
      params.contentHash ?? null,
      params.status,
      JSON.stringify(params.metadata),
    ],
  );
  return String(res.rows[0].id);
}

async function ensureJob(client: PoolClient, orgId: string, sourceId: string, jobId?: string): Promise<string> {
  if (jobId) {
    const existing = await client.query(
      `SELECT id FROM ingestion_jobs WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [jobId, orgId],
    );
    if (existing.rows[0]?.id) {
      await client.query(
        `UPDATE ingestion_jobs
            SET state = 'running', started_at = COALESCE(started_at, NOW())
          WHERE id = $1 AND org_id = $2`,
        [jobId, orgId],
      );
      return String(existing.rows[0].id);
    }
  }
  const inserted = await client.query(
    `INSERT INTO ingestion_jobs (org_id, source_id, state, started_at)
     VALUES ($1, $2, 'running', NOW())
     RETURNING id`,
    [orgId, sourceId],
  );
  return String(inserted.rows[0].id);
}

async function finishJob(params: {
  client: PoolClient;
  orgId: string;
  jobId: string;
  sourceId: string;
  state: 'succeeded' | 'failed';
  error?: string | null;
  contentHash?: string | null;
  extraMeta?: Record<string, unknown>;
}): Promise<void> {
  const safeError = params.error ? redactErrorMessage(params.error) : null;
  await params.client.query(
    `UPDATE ingestion_jobs
        SET state = $1, error = $2, finished_at = NOW()
      WHERE id = $3 AND org_id = $4`,
    [params.state, safeError, params.jobId, params.orgId],
  );
  const sourceStatus = params.state === 'succeeded' ? 'syncing' : 'error';
  const metaPatch: Record<string, unknown> = {
    last_error: safeError,
    ...(params.extraMeta || {}),
  };
  await params.client.query(
    `UPDATE knowledge_sources
        SET status = $1,
            content_hash = COALESCE($2, content_hash),
            metadata = (metadata - 'ingestText' - 'ingestBase64' - 'pendingText') || $3::jsonb
      WHERE id = $4 AND org_id = $5`,
    [sourceStatus, params.contentHash ?? null, JSON.stringify(metaPatch), params.sourceId, params.orgId],
  );
}

function chunkHeader(path: string, modifiedAt: string | null, index: number, total: number): string {
  const modified = modifiedAt || 'unknown';
  return `[path: ${path} | modified_at: ${modified} | chunk: ${index + 1}/${total}]\n`;
}

interface StagedIngest {
  kind: 'staged';
  orgId: string;
  sourceId: string;
  jobId: string;
  catalogPath: string;
  resolvedModified: string | null;
  chunks: string[];
  memorySource: 'drive' | 'upload';
  memoryKind: string | null;
  dataClass: string | null;
  contentHash: string;
}

function isStagedIngest(value: IngestFileActivityResult | StagedIngest): value is StagedIngest {
  return 'kind' in value && (value as StagedIngest).kind === 'staged';
}

async function prepareIngest(input: IngestFileActivityInput): Promise<IngestFileActivityResult | StagedIngest> {
  const orgId = requireOrgId(input.orgId);
  const connector = normalizeConnector(input.connector);
  const catalogConnector = knowledgeConnector(connector);

  return withOrgScopedClient(orgId, async (client) => {
    const source = await loadSource(client, orgId, input.sourceId, input.path, catalogConnector);
    const meta = { ...(source?.metadata || {}) };
    const path = (input.path || source?.path || '').trim();
    const kind = (input.kind ?? (typeof meta.kind === 'string' ? meta.kind : null)) as string | null;
    const dataClass = (input.dataClass ?? (typeof meta.dataClass === 'string' ? meta.dataClass : null)) as string | null;
    const fileId = (input.fileId || (typeof meta.fileId === 'string' ? meta.fileId : '') || '').trim();
    const mimeType = (input.mimeType || (typeof meta.mimeType === 'string' ? meta.mimeType : '') || '').trim();
    const modifiedAt = (
      input.modifiedAt
      || (typeof meta.modifiedAt === 'string' ? meta.modifiedAt : null)
      || source?.last_synced
      || null
    );

    if (!path && !fileId && !meta.ingestText && !meta.ingestBase64) {
      throw ApplicationFailure.nonRetryable('path, fileId, or stored ingest payload is required', 'InvalidArgumentError');
    }

    const catalogPath = path || (fileId ? `drive:${fileId}` : 'upload:unnamed');
    if (isKyc(kind, dataClass, catalogPath)) {
      const sourceId = source?.id || await upsertCatalog({
        client, orgId, connector: catalogConnector, path: catalogPath, status: 'ready',
        metadata: { kind, dataClass, modifiedAt, skipped: 'kyc', last_error: null },
      });
      const jobId = await ensureJob(client, orgId, sourceId, input.jobId);
      await finishJob({
        client, orgId, jobId, sourceId, state: 'succeeded',
        extraMeta: { skipped: 'kyc', modifiedAt, last_error: null },
      });
      return {
        orgId, sourceId, jobId, status: 'skipped' as const, skipReason: 'kyc' as const,
        path: catalogPath, modifiedAt: modifiedAt || undefined, chunkCount: 0, embedJobs: [],
      };
    }

    let bytes: Buffer | null = null;
    let resolvedMime = mimeType;
    let resolvedModified = modifiedAt;
    let resolvedName = catalogPath.split('/').pop() || catalogPath;

    if (typeof meta.ingestText === 'string' && meta.ingestText) {
      bytes = Buffer.from(meta.ingestText, 'utf8');
      resolvedMime = resolvedMime || 'text/plain';
    } else if (typeof meta.ingestBase64 === 'string' && meta.ingestBase64) {
      bytes = Buffer.from(meta.ingestBase64, 'base64');
    } else if (connector === 'google-drive' || connector === 'drive') {
      const token = await googleDriveToken(orgId);
      if (!token) {
        const sourceId = source?.id || await upsertCatalog({
          client, orgId, connector: catalogConnector, path: catalogPath, status: 'error',
          metadata: { last_error: 'google-drive not connected', modifiedAt, connected: false },
        });
        const jobId = await ensureJob(client, orgId, sourceId, input.jobId);
        await finishJob({
          client, orgId, jobId, sourceId, state: 'failed',
          error: 'google-drive not connected. Authorize via Nango OAuth at /connectors.',
          extraMeta: { connected: false, setupUrl: '/connectors' },
        });
        return {
          orgId, sourceId, jobId, status: 'skipped' as const, skipReason: 'not_connected' as const,
          path: catalogPath, modifiedAt: resolvedModified || undefined,
          connected: false, setupUrl: '/connectors',
          error: 'google-drive not connected. Authorize via Nango OAuth at /connectors.',
        };
      }
      if (!fileId) {
        throw ApplicationFailure.nonRetryable('fileId is required for Drive ingest', 'InvalidArgumentError');
      }
      const driveMeta = await driveGetMeta(token, fileId);
      if (!driveMeta) {
        throw new Error('Drive file metadata was not returned');
      }
      resolvedName = driveMeta.name || resolvedName;
      resolvedMime = driveMeta.mimeType || resolvedMime;
      resolvedModified = driveMeta.modifiedTime || resolvedModified;
      bytes = await driveDownload(token, driveMeta);
    }

    if (!bytes) {
      throw ApplicationFailure.nonRetryable('No file bytes to ingest', 'InvalidArgumentError');
    }

    const scan = virusScanStub(bytes);
    const sourceId = source?.id || await upsertCatalog({
      client,
      orgId,
      connector: catalogConnector,
      path: catalogPath,
      status: 'syncing',
      metadata: {
        kind, dataClass, mimeType: resolvedMime, fileId: fileId || null,
        modifiedAt: resolvedModified, parser: null, last_error: null,
      },
    });
    const jobId = await ensureJob(client, orgId, sourceId, input.jobId);

    if (scan.clean === false) {
      await finishJob({
        client, orgId, jobId, sourceId, state: 'failed',
        error: `virus-scan stub rejected payload: ${scan.reason}`,
        extraMeta: { modifiedAt: resolvedModified, skipped: 'virus' },
      });
      return {
        orgId, sourceId, jobId, status: 'skipped' as const, skipReason: 'virus' as const,
        path: catalogPath, modifiedAt: resolvedModified || undefined, error: scan.reason,
      };
    }

    const parsed = await parseFile(bytes, resolvedName, resolvedMime || 'application/octet-stream');
    if (parsed.ok === false) {
      await finishJob({
        client, orgId, jobId, sourceId, state: 'failed',
        error: parsed.message,
        extraMeta: { modifiedAt: resolvedModified, parser: parsed.reason, last_error: redactErrorMessage(parsed.message) },
      });
      return {
        orgId, sourceId, jobId,
        status: parsed.reason === 'unavailable' ? 'skipped' as const : 'failed' as const,
        skipReason: 'parse' as const,
        path: catalogPath, modifiedAt: resolvedModified || undefined, error: parsed.message,
      };
    }

    const redactedWhole = redactForEmbed(parsed.text, { kind, dataClass });
    if (redactedWhole.skipped && redactedWhole.reason === 'kyc') {
      await finishJob({
        client, orgId, jobId, sourceId, state: 'succeeded',
        extraMeta: { skipped: 'kyc', modifiedAt: resolvedModified, last_error: null },
      });
      return {
        orgId, sourceId, jobId, status: 'skipped' as const, skipReason: 'kyc' as const,
        path: catalogPath, modifiedAt: resolvedModified || undefined, chunkCount: 0, embedJobs: [],
      };
    }
    if (redactedWhole.skipped) {
      await finishJob({
        client, orgId, jobId, sourceId, state: 'failed',
        error: 'parsed document was empty after redaction',
        extraMeta: { skipped: 'empty', modifiedAt: resolvedModified },
      });
      return {
        orgId, sourceId, jobId, status: 'skipped' as const, skipReason: 'empty' as const,
        path: catalogPath, modifiedAt: resolvedModified || undefined,
      };
    }

    const chunks = chunkDocument(redactedWhole.text);
    if (chunks.length === 0) {
      await finishJob({
        client, orgId, jobId, sourceId, state: 'failed',
        error: 'chunker produced no text',
        extraMeta: { skipped: 'empty', modifiedAt: resolvedModified },
      });
      return {
        orgId, sourceId, jobId, status: 'skipped' as const, skipReason: 'empty' as const,
        path: catalogPath, modifiedAt: resolvedModified || undefined,
      };
    }

    const contentHash = createHash('sha256').update(redactedWhole.text, 'utf8').digest('hex');
    await client.query(
      `UPDATE knowledge_sources
          SET status = 'syncing',
              content_hash = $1,
              metadata = (metadata - 'ingestText' - 'ingestBase64' - 'pendingText') || $2::jsonb
        WHERE id = $3 AND org_id = $4`,
      [
        contentHash,
        JSON.stringify({
          modifiedAt: resolvedModified,
          mimeType: resolvedMime,
          parser: parsed.parser,
          chunkCount: chunks.length,
          last_error: null,
          path: catalogPath,
        }),
        sourceId,
        orgId,
      ],
    );

    return {
      kind: 'staged' as const,
      orgId,
      sourceId,
      jobId,
      catalogPath,
      resolvedModified,
      chunks,
      memorySource: memorySourceFor(connector),
      memoryKind: kind,
      dataClass,
      contentHash,
    };
  });
}

export async function ingestFileActivity(input: IngestFileActivityInput): Promise<IngestFileActivityResult> {
  const orgId = requireOrgId(input.orgId);
  try {
    const prepared = await prepareIngest(input);
    if (isStagedIngest(prepared)) {
      const embedJobs: string[] = [];
      for (let i = 0; i < prepared.chunks.length; i += 1) {
        const body = `${chunkHeader(prepared.catalogPath, prepared.resolvedModified, i, prepared.chunks.length)}${prepared.chunks[i]}`;
        const queued = await enqueueEmbedJobFromWorker({
          orgId: prepared.orgId,
          source: prepared.memorySource,
          sourceRef: `${prepared.catalogPath}#c${i}`,
          text: body,
          kind: prepared.memoryKind,
          dataClass: prepared.dataClass,
        });
        if (queued.enqueued) embedJobs.push(queued.jobId);
      }

      await withOrgScopedClient(prepared.orgId, async (client) => {
        await finishJob({
          client,
          orgId: prepared.orgId,
          jobId: prepared.jobId,
          sourceId: prepared.sourceId,
          state: 'succeeded',
          contentHash: prepared.contentHash,
          extraMeta: {
            modifiedAt: prepared.resolvedModified,
            chunkCount: prepared.chunks.length,
            embedJobCount: embedJobs.length,
            last_error: null,
            path: prepared.catalogPath,
          },
        });
      });

      return {
        orgId: prepared.orgId,
        sourceId: prepared.sourceId,
        jobId: prepared.jobId,
        status: embedJobs.length > 0 ? 'enqueued' : 'pending',
        path: prepared.catalogPath,
        modifiedAt: prepared.resolvedModified || undefined,
        chunkCount: prepared.chunks.length,
        embedJobs,
      };
    }

    return prepared;
  } catch (err: unknown) {
    if (err instanceof ApplicationFailure) throw err;
    const message = redactErrorMessage(err instanceof Error ? err.message : String(err));
    try {
      await withOrgScopedClient(orgId, async (client) => {
        if (input.sourceId && input.jobId) {
          await finishJob({
            client, orgId, jobId: input.jobId, sourceId: input.sourceId,
            state: 'failed', error: message,
          });
        }
      });
    } catch {
      // still return the failed result
    }
    return {
      orgId,
      sourceId: input.sourceId,
      jobId: input.jobId,
      status: 'failed',
      path: input.path,
      modifiedAt: input.modifiedAt || undefined,
      error: message,
    };
  }
}

async function getCursor(
  client: PoolClient,
  orgId: string,
  connectorKey: string,
  stream: string,
): Promise<string | null> {
  const res = await client.query(
    `SELECT cursor FROM sync_cursors
      WHERE org_id = $1 AND connector_key = $2 AND stream = $3`,
    [orgId, connectorKey, stream],
  );
  return res.rows[0]?.cursor == null ? null : String(res.rows[0].cursor);
}

async function upsertCursor(
  client: PoolClient,
  orgId: string,
  connectorKey: string,
  stream: string,
  cursor: string,
): Promise<void> {
  await client.query(
    `INSERT INTO sync_cursors (org_id, connector_key, stream, cursor, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (org_id, connector_key, stream)
     DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = NOW()`,
    [orgId, connectorKey, stream, cursor],
  );
}

async function markConflict(
  client: PoolClient,
  orgId: string,
  path: string,
  connectors: string[],
  hashes: string[],
): Promise<number> {
  const res = await client.query(
    `UPDATE knowledge_sources
        SET status = 'conflict',
            metadata = metadata || $1::jsonb
      WHERE org_id = $2 AND path = $3 AND connector = ANY($4::text[])`,
    [JSON.stringify({ conflict: { connectors, hashes, markedAt: new Date().toISOString() } }), orgId, path, connectors],
  );
  return res.rowCount || 0;
}

async function existingHashByPath(
  client: PoolClient,
  orgId: string,
  path: string,
  notConnector: string,
): Promise<{ connector: string; content_hash: string } | null> {
  const res = await client.query(
    `SELECT connector, content_hash FROM knowledge_sources
      WHERE org_id = $1 AND path = $2 AND connector <> $3 AND content_hash IS NOT NULL
      LIMIT 1`,
    [orgId, path, notConnector],
  );
  const row = res.rows[0];
  if (!row?.content_hash) return null;
  return { connector: String(row.connector), content_hash: String(row.content_hash) };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function rowHash(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

async function syncDriveFiles(params: {
  orgId: string;
  stream: string;
}): Promise<SyncConnectorActivityResult> {
  const token = await googleDriveToken(params.orgId);
  if (!token) {
    return {
      status: 'not_connected',
      upserted: 0,
      skipped: 0,
      conflicts: 0,
      pendingIngest: [],
      connected: false,
      setupUrl: '/connectors',
      error: 'google-drive not connected. Authorize via Nango OAuth at /connectors to enable real actions.',
    };
  }

  return withOrgScopedClient(params.orgId, async (client) => {
    const prev = await getCursor(client, params.orgId, 'google-drive', params.stream);
    const cursorState = prev ? asRecord(safeJson(prev)) : {};
    const modifiedAfter = typeof cursorState.modifiedTime === 'string' ? cursorState.modifiedTime : null;
    let pageToken = typeof cursorState.pageToken === 'string' ? cursorState.pageToken : '';
    const pendingIngest: PendingIngestItem[] = [];
    let upserted = 0;
    let skipped = 0;
    let conflicts = 0;
    let latestModified = modifiedAfter;
    let pages = 0;
    let filesSeen = 0;

    while (pages < MAX_DRIVE_PAGES && filesSeen < MAX_DRIVE_FILES) {
      pages += 1;
      const q = modifiedAfter
        ? `trashed = false and modifiedTime > '${modifiedAfter.replace(/'/g, "\\'")}'`
        : 'trashed = false';
      const qs = new URLSearchParams({
        q,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum)',
        pageSize: '25',
        orderBy: 'modifiedTime',
      });
      if (pageToken) qs.set('pageToken', pageToken);
      const res = await fetchWithTimeout(
        `https://www.googleapis.com/drive/v3/files?${qs.toString()}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.status === 401 || res.status === 403) {
        return {
          status: 'not_connected',
          upserted, skipped, conflicts, pendingIngest,
          connected: false, setupUrl: '/connectors',
          error: 'google-drive connection revoked or expired. Re-authorize at /connectors.',
        };
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Drive list HTTP ${res.status}: ${redactErrorMessage(body)}`);
      }
      const data = await res.json() as { nextPageToken?: string; files?: DriveFileMeta[] };
      const files = Array.isArray(data.files) ? data.files : [];
      for (const file of files) {
        if (!file.id || !file.name) continue;
        filesSeen += 1;
        const path = `${file.id}/${file.name}`;
        const hash = file.md5Checksum || createHash('sha256').update(`${file.id}:${file.modifiedTime || ''}`).digest('hex');
        const existing = await client.query(
          `SELECT id, content_hash FROM knowledge_sources
            WHERE org_id = $1 AND connector = 'drive' AND path = $2 LIMIT 1`,
          [params.orgId, path],
        );
        if (existing.rows[0]?.content_hash === hash) {
          skipped += 1;
          continue;
        }
        const other = await existingHashByPath(client, params.orgId, path, 'drive');
        if (other && other.content_hash !== hash) {
          conflicts += 1;
          await markConflict(client, params.orgId, path, ['drive', other.connector], [hash, other.content_hash]);
          continue;
        }
        const sourceId = await upsertCatalog({
          client,
          orgId: params.orgId,
          connector: 'drive',
          path,
          contentHash: hash,
          status: 'pending',
          metadata: {
            fileId: file.id,
            mimeType: file.mimeType,
            modifiedAt: file.modifiedTime || null,
            last_error: null,
          },
        });
        const job = await client.query(
          `INSERT INTO ingestion_jobs (org_id, source_id, state, cursor)
           VALUES ($1, $2, 'queued', $3)
           RETURNING id`,
          [params.orgId, sourceId, hash],
        );
        pendingIngest.push({
          sourceId,
          jobId: String(job.rows[0].id),
          connector: 'google-drive',
          path,
          fileId: file.id,
          mimeType: file.mimeType,
          modifiedAt: file.modifiedTime || null,
        });
        upserted += 1;
        if (file.modifiedTime && (!latestModified || file.modifiedTime > latestModified)) {
          latestModified = file.modifiedTime;
        }
        if (filesSeen >= MAX_DRIVE_FILES) break;
      }
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }

    const nextCursor = JSON.stringify({
      modifiedTime: latestModified || modifiedAfter || null,
      pageToken: pageToken || null,
    });
    await upsertCursor(client, params.orgId, 'google-drive', params.stream, nextCursor);

    return {
      status: 'listed',
      upserted,
      skipped,
      conflicts,
      cursor: nextCursor,
      pendingIngest,
      connected: true,
    };
  });
}

async function syncSheetsInventory(params: {
  orgId: string;
  stream: string;
}): Promise<SyncConnectorActivityResult> {
  const connId = `${params.orgId}_google-sheets`;
  let token: string | null = null;
  for (const providerKey of ['google-sheets', 'google'] as const) {
    token = await getNangoAccessToken(connId, providerKey);
    if (token) break;
  }
  if (!token) {
    return {
      status: 'not_connected',
      upserted: 0, skipped: 0, conflicts: 0, pendingIngest: [],
      connected: false, setupUrl: '/connectors',
      error: 'google-sheets not connected. Authorize via Nango OAuth at /connectors to enable real actions.',
    };
  }

  return withOrgScopedClient(params.orgId, async (client) => {
    const prev = await getCursor(client, params.orgId, 'google-sheets', params.stream);
    const cursorState = prev ? asRecord(safeJson(prev)) : {};
    const spreadsheetId = typeof cursorState.spreadsheetId === 'string' ? cursorState.spreadsheetId : '';
    if (!spreadsheetId) {
      await upsertCursor(client, params.orgId, 'google-sheets', params.stream, JSON.stringify({
        spreadsheetId: null,
        note: 'Set spreadsheetId on sync_cursors.cursor to sync inventory. No sheet was guessed.',
      }));
      return {
        status: 'listed',
        upserted: 0, skipped: 0, conflicts: 0, pendingIngest: [],
        cursor: prev,
        connected: true,
      };
    }
    const range = typeof cursorState.range === 'string' ? cursorState.range : 'Sheet1!A1:Z500';
    const res = await fetchWithTimeout(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 401 || res.status === 403) {
      return {
        status: 'not_connected',
        upserted: 0, skipped: 0, conflicts: 0, pendingIngest: [],
        connected: false, setupUrl: '/connectors',
        error: 'google-sheets connection revoked or expired. Re-authorize at /connectors.',
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Sheets read HTTP ${res.status}: ${redactErrorMessage(body)}`);
    }
    const data = await res.json() as { values?: string[][] };
    const rows = Array.isArray(data.values) ? data.values : [];
    const header = (rows[0] || []).map((h) => String(h).trim().toLowerCase());
    const emailIdx = header.findIndex((h) => h === 'email' || h === 'contact' || h === 'source_ref');
    let upserted = 0;
    let skipped = 0;
    let conflicts = 0;
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i] || [];
      const key = (emailIdx >= 0 ? row[emailIdx] : row[0]) || '';
      const sourceRef = String(key).trim();
      if (!sourceRef) continue;
      const path = `contact:${sourceRef.toLowerCase()}`;
      const hash = rowHash(row.map(String));
      const existing = await client.query(
        `SELECT id, content_hash FROM knowledge_sources
          WHERE org_id = $1 AND connector = 'sheets' AND path = $2 LIMIT 1`,
        [params.orgId, path],
      );
      if (existing.rows[0]?.content_hash === hash) {
        skipped += 1;
        continue;
      }
      const other = await existingHashByPath(client, params.orgId, path, 'sheets');
      if (other && other.content_hash !== hash) {
        conflicts += 1;
        await markConflict(client, params.orgId, path, ['sheets', other.connector], [hash, other.content_hash]);
        continue;
      }
      await upsertCatalog({
        client,
        orgId: params.orgId,
        connector: 'sheets',
        path,
        contentHash: hash,
        status: 'ready',
        metadata: { spreadsheetId, row: i + 1, source_ref: sourceRef, last_error: null },
      });
      upserted += 1;
    }
    const nextCursor = JSON.stringify({ spreadsheetId, range, rowCount: rows.length });
    await upsertCursor(client, params.orgId, 'google-sheets', params.stream, nextCursor);
    return {
      status: 'listed',
      upserted, skipped, conflicts, pendingIngest: [],
      cursor: nextCursor, connected: true,
    };
  });
}

async function syncHubspotContacts(params: {
  orgId: string;
  stream: string;
}): Promise<SyncConnectorActivityResult> {
  const token = await getNangoAccessToken(`${params.orgId}_hubspot`, 'hubspot');
  if (!token) {
    return {
      status: 'not_connected',
      upserted: 0, skipped: 0, conflicts: 0, pendingIngest: [],
      connected: false, setupUrl: '/connectors',
      error: 'hubspot not connected. Authorize via Nango OAuth at /connectors to enable real actions.',
    };
  }

  return withOrgScopedClient(params.orgId, async (client) => {
    const prev = await getCursor(client, params.orgId, 'hubspot', params.stream);
    const after = prev || undefined;
    const qs = new URLSearchParams({
      limit: '50',
      properties: 'email,firstname,lastname,lastmodifieddate',
    });
    if (after) qs.set('after', after);
    const res = await fetchWithTimeout(
      `https://api.hubapi.com/crm/v3/objects/contacts?${qs.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 401 || res.status === 403) {
      return {
        status: 'not_connected',
        upserted: 0, skipped: 0, conflicts: 0, pendingIngest: [],
        connected: false, setupUrl: '/connectors',
        error: 'hubspot connection revoked or expired. Re-authorize at /connectors.',
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HubSpot list HTTP ${res.status}: ${redactErrorMessage(body)}`);
    }
    const data = await res.json() as {
      results?: Array<{ id: string; properties?: Record<string, string | null> }>;
      paging?: { next?: { after?: string } };
    };
    const results = Array.isArray(data.results) ? data.results : [];
    let upserted = 0;
    let skipped = 0;
    let conflicts = 0;
    for (const contact of results) {
      const email = (contact.properties?.email || '').trim().toLowerCase();
      if (!email) continue;
      const path = `contact:${email}`;
      const hash = rowHash([
        contact.id,
        email,
        contact.properties?.firstname || '',
        contact.properties?.lastname || '',
        contact.properties?.lastmodifieddate || '',
      ]);
      const existing = await client.query(
        `SELECT id, content_hash FROM knowledge_sources
          WHERE org_id = $1 AND connector = 'crm' AND path = $2 LIMIT 1`,
        [params.orgId, path],
      );
      if (existing.rows[0]?.content_hash === hash) {
        skipped += 1;
        continue;
      }
      const other = await existingHashByPath(client, params.orgId, path, 'crm');
      if (other && other.content_hash !== hash) {
        conflicts += 1;
        await markConflict(client, params.orgId, path, ['crm', other.connector], [hash, other.content_hash]);
        continue;
      }
      await upsertCatalog({
        client,
        orgId: params.orgId,
        connector: 'crm',
        path,
        contentHash: hash,
        status: 'ready',
        metadata: {
          hubspotId: contact.id,
          source_ref: email,
          last_error: null,
        },
      });
      upserted += 1;
    }
    const nextCursor = data.paging?.next?.after || after || '';
    if (nextCursor) {
      await upsertCursor(client, params.orgId, 'hubspot', params.stream, nextCursor);
    }
    return {
      status: 'listed',
      upserted, skipped, conflicts, pendingIngest: [],
      cursor: nextCursor || prev, connected: true,
    };
  });
}

export async function syncConnectorActivity(input: SyncConnectorActivityInput): Promise<SyncConnectorActivityResult> {
  const orgId = requireOrgId(input.orgId);
  const stream = (input.stream || 'files').trim() || 'files';
  try {
    switch (input.connectorKey) {
      case 'google-drive':
        return await syncDriveFiles({ orgId, stream });
      case 'google-sheets':
        return await syncSheetsInventory({ orgId, stream });
      case 'hubspot':
        return await syncHubspotContacts({ orgId, stream });
      default: {
        const _exhaustive: never = input.connectorKey;
        throw ApplicationFailure.nonRetryable(
          `Unsupported sync connector: ${String(_exhaustive)}`,
          'InvalidArgumentError',
        );
      }
    }
  } catch (err: unknown) {
    if (err instanceof ApplicationFailure) throw err;
    const message = redactErrorMessage(err instanceof Error ? err.message : String(err));
    return {
      status: 'failed',
      upserted: 0,
      skipped: 0,
      conflicts: 0,
      pendingIngest: [],
      error: message,
    };
  }
}
