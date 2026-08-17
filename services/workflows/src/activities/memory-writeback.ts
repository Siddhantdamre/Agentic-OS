/**
 * MemoryWriteBack activity (M4). Runs off the webhook HTTP thread via
 * MemoryWriteBackWorkflow. Extracts facts with LiteLLM JSON, hash-upserts,
 * never writes inferred prices into list_price, and flags needs_attention
 * on low-confidence extracts.
 */

import { createHash } from 'crypto';
import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { ApplicationFailure } from '@temporalio/activity';
import { Pool, PoolClient } from 'pg';
import type {
  MemoryEdgeRel,
  MemoryFieldUpdate,
  MemoryOpenQuestion,
  MemoryRelationExtract,
  MemorySourceKind,
  MemoryWriteBackFact,
  MemoryWriteBackPayload,
} from '@darex/shared-types';
import { MEMORY_EDGE_RELS, MEMORY_SOURCE_KINDS } from '@darex/shared-types';
import { enqueueEmbedJobFromWorker } from './embed.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOURCE_KIND_SET = new Set<string>(MEMORY_SOURCE_KINDS);
const EDGE_REL_SET = new Set<string>(MEMORY_EDGE_RELS);

const DEFAULT_MIN_CONFIDENCE = parseFloat(process.env.MEMORY_WRITEBACK_MIN_CONFIDENCE || '0.75');
const EXTRACT_TIMEOUT_MS = parseInt(process.env.MEMORY_WRITEBACK_TIMEOUT_MS || '25000', 10);
const TRANSCRIPT_LIMIT = 40;
const FACT_BODY_MAX = 4000;

/** Fields that must never be written from model world-knowledge. */
const PROTECTED_PRICE_FIELDS = new Set(['list_price', 'price', 'rent', 'asking_price', 'sale_price']);
const PROTECTED_LEGAL_FIELDS = new Set(['legal_id', 'pan', 'aadhaar', 'payment', 'payment_id', 'kyc']);

const ENTITY_SCHEMA: Record<string, ReadonlySet<string>> = {
  contact: new Set(['name', 'phone', 'email', 'budget_min', 'budget_max', 'preference', 'bhk', 'area', 'last_issue', 'notes']),
  listing: new Set(['title', 'area', 'bhk', 'list_price', 'status', 'address', 'notes']),
  conversation: new Set(['summary', 'status', 'preference']),
  work_item: new Set(['status', 'assignee']),
  company: new Set(['name', 'notes']),
};

export type FieldUpdateDecision = 'apply' | 'needs_attention';

export interface MemoryWriteBackInput {
  orgId: string;
  workItemId?: string;
  conversationId: string;
  transcriptExcerpt?: string;
  toolResults?: unknown;
  closed?: boolean;
  businessKey?: string;
}

export interface MemoryWriteBackResult {
  written: boolean;
  factCount: number;
  skippedDuplicates: number;
  fieldUpdatesApplied: number;
  needsAttention: boolean;
  openQuestionCount: number;
  noOp?: boolean;
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'darex_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'darex',
  max: 5,
});

function requireOrgId(orgId: string | undefined): string {
  if (!orgId || !UUID_RE.test(orgId)) {
    throw ApplicationFailure.nonRetryable('orgId is required', 'InvalidArgumentError');
  }
  return orgId;
}

function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function minConfidence(): number {
  return Number.isFinite(DEFAULT_MIN_CONFIDENCE) ? DEFAULT_MIN_CONFIDENCE : 0.75;
}

export function hashFactText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function asSource(raw: string | null | undefined): MemorySourceKind {
  const value = (raw || '').trim();
  if (SOURCE_KIND_SET.has(value)) return value as MemorySourceKind;
  return 'conversation';
}

function asRel(raw: string | null | undefined): MemoryEdgeRel | null {
  const value = (raw || '').trim();
  if (EDGE_REL_SET.has(value)) return value as MemoryEdgeRel;
  return null;
}

function isProtectedPriceField(field: string): boolean {
  return PROTECTED_PRICE_FIELDS.has(field.trim().toLowerCase());
}

function isProtectedLegalField(field: string): boolean {
  return PROTECTED_LEGAL_FIELDS.has(field.trim().toLowerCase());
}

function toolResultsMentionPrice(toolResults: unknown): boolean {
  if (toolResults == null) return false;
  const blob = JSON.stringify(toolResults).toLowerCase();
  if (!blob || blob === 'null' || blob === '[]' || blob === '{}') return false;
  return /list_price|"price"|asking_price|rent|sale_price/.test(blob);
}

/**
 * Apply only when confidence ≥ threshold or human-confirmed.
 * Inferred (non-tool) prices/legal ids never land on list_price — they
 * become needs_attention instead.
 */
export function decideFieldUpdate(
  update: Pick<MemoryFieldUpdate, 'field' | 'confidence' | 'confirmed'>,
  opts: { fromToolResults: boolean; minConfidence?: number }
): FieldUpdateDecision {
  const field = (update.field || '').trim().toLowerCase();
  const protectedPrice = isProtectedPriceField(field);
  const protectedLegal = isProtectedLegalField(field);
  if ((protectedPrice || protectedLegal) && !opts.fromToolResults) {
    return 'needs_attention';
  }
  const threshold = opts.minConfidence ?? minConfidence();
  if (update.confirmed === true || update.confidence >= threshold) return 'apply';
  return 'needs_attention';
}

function entityFieldAllowed(entityType: string, field: string): boolean {
  const allowed = ENTITY_SCHEMA[entityType.trim().toLowerCase()];
  if (!allowed) return false;
  return allowed.has(field.trim().toLowerCase());
}

async function withOrgClient<T>(orgId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_org_id', $1, false)", [orgId]);
    return await fn(client);
  } finally {
    try {
      await client.query('RESET app.current_org_id');
    } catch {
      // always release
    }
    client.release();
  }
}

function litellmChatUrl(): string {
  const base = (process.env.LITELLM_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

export function parseWriteBackExtract(raw: unknown): MemoryWriteBackPayload {
  const empty: MemoryWriteBackPayload = { facts: [], fieldUpdates: [], openQuestions: [], relations: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const rec = raw as Record<string, unknown>;
  const factsRaw = Array.isArray(rec.facts) ? rec.facts : [];
  const updatesRaw = Array.isArray(rec.field_updates)
    ? rec.field_updates
    : Array.isArray(rec.fieldUpdates)
      ? rec.fieldUpdates
      : [];
  const questionsRaw = Array.isArray(rec.open_questions)
    ? rec.open_questions
    : Array.isArray(rec.openQuestions)
      ? rec.openQuestions
      : [];
  const relsRaw = Array.isArray(rec.relations) ? rec.relations : [];

  const facts: MemoryWriteBackFact[] = [];
  for (const item of factsRaw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const text = asString(row.text).replace(/\s+/g, ' ').trim();
    if (!text || text.length < 8) continue;
    facts.push({
      text: text.slice(0, FACT_BODY_MAX),
      confidence: Math.min(1, Math.max(0, asNumber(row.confidence, 0))),
      source: asSource(asString(row.source) || 'conversation'),
      sourceRef: asString(row.source_ref || row.sourceRef) || null,
      contentHash: hashFactText(text),
    });
  }

  const fieldUpdates: MemoryFieldUpdate[] = [];
  for (const item of updatesRaw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const entityType = asString(row.entity_type || row.entityType).trim();
    const entityId = asString(row.entity_id || row.entityId).trim();
    const field = asString(row.field).trim().toLowerCase();
    if (!entityType || !entityId || !field) continue;
    fieldUpdates.push({
      entityType,
      entityId,
      field,
      value: row.value,
      confidence: Math.min(1, Math.max(0, asNumber(row.confidence, 0))),
      confirmed: row.confirmed === true,
    });
  }

  const openQuestions: MemoryOpenQuestion[] = [];
  for (const item of questionsRaw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const text = asString(row.text).trim();
    if (!text) continue;
    openQuestions.push({
      text: text.slice(0, 1000),
      entityType: asString(row.entity_type || row.entityType) || undefined,
      entityId: asString(row.entity_id || row.entityId) || undefined,
    });
  }

  const relations: MemoryRelationExtract[] = [];
  for (const item of relsRaw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const fromId = asString(row.from_id || row.fromId).trim();
    const toId = asString(row.to_id || row.toId).trim();
    const rel = asRel(asString(row.rel));
    if (!isUuid(fromId) || !isUuid(toId) || !rel) continue;
    relations.push({
      fromId,
      toId,
      rel,
      weight: asNumber(row.weight, 1),
    });
  }

  return { facts, fieldUpdates, openQuestions, relations };
}

async function extractWithLiteLLM(params: {
  transcript: string;
  toolResults: unknown;
  closed: boolean;
}): Promise<MemoryWriteBackPayload> {
  const apiKey = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || '';
  const model = process.env.LITELLM_MODEL || '';
  if (!apiKey || !model || !params.transcript.trim()) {
    return { facts: [], fieldUpdates: [], openQuestions: [], relations: [] };
  }

  const system = [
    'You extract durable org memory from a business conversation.',
    'Reply with ONLY JSON: {"facts":[],"field_updates":[],"open_questions":[],"relations":[]}.',
    'facts[].text must be a short grounded sentence. facts[].confidence is 0..1. facts[].source is conversation|tool|human|crm|whatsapp.',
    'field_updates[]: entity_type, entity_id, field, value, confidence, confirmed.',
    'Prices, legal ids, and payments: copy ONLY from tool_results, never from world knowledge or user guesses.',
    'Never invent listings, list_price, rents, or contact names that are not in the transcript or tool_results.',
    'If unsure, put an open_question instead of a field_update. Low confidence < 0.75 should not assert list_price.',
    'Do not extract KYC / PAN / Aadhaar numbers.',
    'relations[] only when both ids are real UUIDs from the transcript; otherwise omit.',
  ].join(' ');

  const user = [
    params.closed ? 'Conversation is closed. Summarize durable facts.' : 'Successful turn. Extract new durable facts only.',
    'Transcript:',
    params.transcript.slice(0, 12000),
    'Tool results (authoritative for prices/legal/payments):',
    JSON.stringify(params.toolResults ?? []).slice(0, 8000),
  ].join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
  try {
    const res = await fetch(litellmChatUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        max_tokens: 800,
        temperature: 0,
        reasoning: { enabled: false },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { facts: [], fieldUpdates: [], openQuestions: [], relations: [] };
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content || '';
    return parseWriteBackExtract(extractJsonObject(content));
  } catch {
    return { facts: [], fieldUpdates: [], openQuestions: [], relations: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function loadTranscript(
  client: PoolClient,
  orgId: string,
  conversationId: string
): Promise<{ text: string; closed: boolean; toolResults: unknown }> {
  const conv = await client.query(
    `SELECT status FROM conversations WHERE id = $1 AND org_id = $2 LIMIT 1`,
    [conversationId, orgId]
  );
  const status = String(conv.rows[0]?.status || 'open');
  const closed = status === 'resolved' || status === 'closed';
  const msgs = await client.query(
    `SELECT role, content, tool_calls FROM (
       SELECT role, content, tool_calls, created_at
       FROM messages
       WHERE org_id = $1 AND conversation_id = $2
       ORDER BY created_at DESC
       LIMIT $3
     ) sub ORDER BY created_at ASC`,
    [orgId, conversationId, TRANSCRIPT_LIMIT]
  );
  const lines = msgs.rows.map((r) => `${r.role}: ${String(r.content || '').slice(0, 800)}`);
  const lastTools = [...msgs.rows].reverse().find((r) => r.tool_calls)?.tool_calls ?? null;
  return { text: lines.join('\n').slice(0, 14000), closed, toolResults: lastTools };
}

async function upsertConversationFact(
  client: PoolClient,
  params: {
    orgId: string;
    conversationId: string;
    text: string;
    source: MemorySourceKind;
    sourceRef: string;
    contentHash: string;
    metadata: Record<string, unknown>;
    kind: string;
  }
): Promise<'inserted' | 'duplicate'> {
  const title = params.text.split('\n').find((p) => p.trim())?.slice(0, 120) || 'memory';
  const res = await client.query(
    `INSERT INTO conversation_memory (
       org_id, conversation_id, kind, title, summary, body,
       source, source_ref, content_hash, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (org_id, source, source_ref, content_hash) DO NOTHING
     RETURNING id`,
    [
      params.orgId,
      params.conversationId,
      params.kind,
      title,
      params.text.slice(0, 2000),
      params.text,
      params.source,
      params.sourceRef,
      params.contentHash,
      JSON.stringify(params.metadata),
    ]
  );
  return res.rows[0]?.id ? 'inserted' : 'duplicate';
}

async function upsertEntityFact(
  client: PoolClient,
  params: {
    orgId: string;
    entityType: string;
    entityId: string;
    text: string;
    source: MemorySourceKind;
    sourceRef: string;
    contentHash: string;
    metadata: Record<string, unknown>;
  }
): Promise<'inserted' | 'duplicate'> {
  const title = params.text.split('\n').find((p) => p.trim())?.slice(0, 120) || params.entityType;
  const res = await client.query(
    `INSERT INTO entity_memory (
       org_id, entity_type, entity_id, kind, title, body,
       source, source_ref, content_hash, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (org_id, source, source_ref, content_hash) DO NOTHING
     RETURNING id`,
    [
      params.orgId,
      params.entityType,
      params.entityId,
      'fact',
      title,
      params.text,
      params.source,
      params.sourceRef,
      params.contentHash,
      JSON.stringify(params.metadata),
    ]
  );
  return res.rows[0]?.id ? 'inserted' : 'duplicate';
}

async function applyEntityField(
  client: PoolClient,
  params: {
    orgId: string;
    update: MemoryFieldUpdate;
    source: MemorySourceKind;
    sourceRef: string;
  }
): Promise<void> {
  const field = params.update.field.trim().toLowerCase();
  const entityType = params.update.entityType.trim().toLowerCase();
  const fields = { [field]: params.update.value };
  const body = `${entityType} ${params.update.entityId}: ${field}=${JSON.stringify(params.update.value)}`;
  const contentHash = hashFactText(`${entityType}|${params.update.entityId}|${field}|${JSON.stringify(params.update.value)}`);
  await client.query(
    `INSERT INTO entity_memory (
       org_id, entity_type, entity_id, kind, title, body,
       source, source_ref, content_hash, metadata
     ) VALUES ($1, $2, $3, 'fact', $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (org_id, source, source_ref, content_hash) DO UPDATE SET
       metadata = entity_memory.metadata || EXCLUDED.metadata,
       body = EXCLUDED.body,
       updated_at = NOW()`,
    [
      params.orgId,
      entityType,
      params.update.entityId,
      `${entityType} ${field}`,
      body.slice(0, FACT_BODY_MAX),
      params.source,
      params.sourceRef,
      contentHash,
      JSON.stringify({ fields, confidence: params.update.confidence, confirmed: params.update.confirmed }),
    ]
  );
}

async function insertRelation(
  client: PoolClient,
  orgId: string,
  rel: MemoryRelationExtract
): Promise<void> {
  await client.query(
    `INSERT INTO memory_edges (org_id, from_id, to_id, rel, weight)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, from_id, to_id, rel) DO NOTHING`,
    [orgId, rel.fromId, rel.toId, rel.rel, rel.weight ?? 1]
  );
}

async function markNeedsAttention(
  client: PoolClient,
  params: { orgId: string; workItemId?: string; conversationId: string; reason: string }
): Promise<void> {
  if (isUuid(params.workItemId)) {
    await client.query(`UPDATE work_items SET status = 'needs_attention' WHERE id = $1 AND org_id = $2`, [
      params.workItemId,
      params.orgId,
    ]);
  }
  await client.query(
    `UPDATE conversations SET status = 'needs_attention', updated_at = NOW() WHERE id = $1 AND org_id = $2`,
    [params.conversationId, params.orgId]
  );
  await client.query(
    `INSERT INTO channel_logs (org_id, channel_type, event_type, status, status_code, message, payload)
     VALUES ($1, 'agent', 'MEMORY_NEEDS_ATTENTION', 'error', 500, $2, $3)`,
    [
      params.orgId,
      params.reason.slice(0, 500),
      JSON.stringify({ conversationId: params.conversationId, workItemId: params.workItemId || null }),
    ]
  );
}

function encodeRedisCommand(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const data = Buffer.from(arg, 'utf8');
    parts.push(Buffer.from(`$${data.length}\r\n`), data, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

function redisTarget(): { host: string; port: number; password: string; tls: boolean } | null {
  const configured = process.env.REDIS_URL?.trim() || '';
  if (!configured || /langfuse-redis/i.test(configured)) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') return null;
    return {
      host: url.hostname || '127.0.0.1',
      port: url.port ? Number(url.port) : 6379,
      password: decodeURIComponent(url.password || ''),
      tls: url.protocol === 'rediss:',
    };
  } catch {
    return null;
  }
}

/** Best-effort Redis PUBLISH of memory.updated. Missing bus is not a write failure. */
export async function publishMemoryUpdated(orgId: string, extra: Record<string, unknown>): Promise<void> {
  const target = redisTarget();
  if (!target) return;
  const payload = JSON.stringify({
    type: 'memory.updated',
    orgId,
    ts: Date.now(),
    ...extra,
  });
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    let socket: Socket;
    try {
      socket = target.tls
        ? tlsConnect({ host: target.host, port: target.port, servername: target.host })
        : createConnection({ host: target.host, port: target.port });
    } catch {
      done();
      return;
    }
    const timer = setTimeout(() => {
      socket.destroy();
      done();
    }, 3000);
    socket.once('error', () => {
      clearTimeout(timer);
      done();
    });
    socket.once(target.tls ? 'secureConnect' : 'connect', () => {
      try {
        if (target.password) socket.write(encodeRedisCommand(['AUTH', target.password]));
        socket.write(encodeRedisCommand(['PUBLISH', `org:${orgId}`, payload]));
        socket.write(encodeRedisCommand(['QUIT']));
      } catch {
        socket.destroy();
      }
      setTimeout(() => {
        clearTimeout(timer);
        socket.destroy();
        done();
      }, 200);
    });
  });
}

export async function memoryWriteBackActivity(input: MemoryWriteBackInput): Promise<MemoryWriteBackResult> {
  const orgId = requireOrgId(input.orgId);
  if (!isUuid(input.conversationId)) {
    throw ApplicationFailure.nonRetryable('conversationId is required', 'InvalidArgumentError');
  }

  const loaded = await withOrgClient(orgId, (client) => loadTranscript(client, orgId, input.conversationId));
  const transcript = (input.transcriptExcerpt || loaded.text || '').trim();
  const closed = input.closed === true || loaded.closed;
  const toolResults = input.toolResults ?? loaded.toolResults;
  const fromToolResults = toolResultsMentionPrice(toolResults);
  const sourceRef = input.conversationId;

  if (!transcript) {
    return {
      written: false,
      factCount: 0,
      skippedDuplicates: 0,
      fieldUpdatesApplied: 0,
      needsAttention: false,
      openQuestionCount: 0,
      noOp: true,
    };
  }

  const extracted = await extractWithLiteLLM({ transcript, toolResults, closed });
  let factCount = 0;
  let skippedDuplicates = 0;
  let fieldUpdatesApplied = 0;
  let needsAttention = false;
  const attentionReasons: string[] = [];

  const applied = await withOrgClient(orgId, async (client) => {
    if (closed) {
      const closedBody = `Closed conversation facts.\n${transcript.slice(0, 3000)}`;
      const closedHash = hashFactText(`closed:${input.conversationId}:${closedBody}`);
      const closedResult = await upsertConversationFact(client, {
        orgId,
        conversationId: input.conversationId,
        text: closedBody,
        source: 'conversation',
        sourceRef,
        contentHash: closedHash,
        metadata: { closed: true, workItemId: input.workItemId || null },
        kind: 'summary',
      });
      if (closedResult === 'inserted') factCount += 1;
      else skippedDuplicates += 1;
    }

    for (const fact of extracted.facts) {
      const hash = fact.contentHash || hashFactText(fact.text);
      const result = await upsertConversationFact(client, {
        orgId,
        conversationId: input.conversationId,
        text: fact.text,
        source: fact.source,
        sourceRef: fact.sourceRef || sourceRef,
        contentHash: hash,
        metadata: { confidence: fact.confidence, workItemId: input.workItemId || null },
        kind: 'fact',
      });
      if (result === 'inserted') factCount += 1;
      else skippedDuplicates += 1;
    }

    for (const update of extracted.fieldUpdates) {
      if (!entityFieldAllowed(update.entityType, update.field)) {
        attentionReasons.push(`invalid field ${update.entityType}.${update.field}`);
        needsAttention = true;
        continue;
      }
      const decision = decideFieldUpdate(update, { fromToolResults, minConfidence: minConfidence() });
      switch (decision) {
        case 'apply': {
          await applyEntityField(client, {
            orgId,
            update,
            source: fromToolResults ? 'tool' : 'conversation',
            sourceRef,
          });
          fieldUpdatesApplied += 1;
          break;
        }
        case 'needs_attention': {
          needsAttention = true;
          attentionReasons.push(
            isProtectedPriceField(update.field)
              ? `refused inferred ${update.field} (not from tool results)`
              : `low-confidence ${update.entityType}.${update.field}`
          );
          const pendingText = `needs_attention: confirm ${update.entityType} ${update.entityId} ${update.field}=${JSON.stringify(update.value)}`;
          await upsertEntityFact(client, {
            orgId,
            entityType: update.entityType,
            entityId: update.entityId,
            text: pendingText,
            source: 'human',
            sourceRef: `${sourceRef}:pending:${update.field}`,
            contentHash: hashFactText(pendingText),
            metadata: { needsAttention: true, field: update.field, value: update.value, confidence: update.confidence },
          });
          break;
        }
        default: {
          const _exhaustive: never = decision;
          return _exhaustive;
        }
      }
    }

    for (const q of extracted.openQuestions) {
      const body = `open_question: ${q.text}`;
      const result = await upsertConversationFact(client, {
        orgId,
        conversationId: input.conversationId,
        text: body,
        source: 'conversation',
        sourceRef: `${sourceRef}:q:${hashFactText(q.text).slice(0, 12)}`,
        contentHash: hashFactText(body),
        metadata: { openQuestion: true, entityType: q.entityType || null, entityId: q.entityId || null },
        kind: 'note',
      });
      if (result === 'inserted') factCount += 1;
      else skippedDuplicates += 1;
    }

    for (const rel of extracted.relations) {
      await insertRelation(client, orgId, rel);
    }

    if (needsAttention) {
      await markNeedsAttention(client, {
        orgId,
        workItemId: input.workItemId,
        conversationId: input.conversationId,
        reason: attentionReasons.join('; ') || 'low-confidence memory extract',
      });
    }

    return { factCount, skippedDuplicates, fieldUpdatesApplied, needsAttention };
  });

  if (applied.factCount > 0 || applied.fieldUpdatesApplied > 0) {
    try {
      await enqueueEmbedJobFromWorker({
        orgId,
        source: 'conversation',
        sourceRef,
        text: transcript.slice(0, 8000),
      });
    } catch (err) {
      console.warn(
        '[memory-writeback] embed enqueue failed:',
        err instanceof Error ? err.message : err
      );
    }
    await publishMemoryUpdated(orgId, {
      conversationId: input.conversationId,
      message: 'Memory updated',
    }).catch(() => undefined);
  }

  return {
    written: applied.factCount > 0 || applied.fieldUpdatesApplied > 0,
    factCount: applied.factCount,
    skippedDuplicates: applied.skippedDuplicates,
    fieldUpdatesApplied: applied.fieldUpdatesApplied,
    needsAttention: applied.needsAttention,
    openQuestionCount: extracted.openQuestions.length,
  };
}
