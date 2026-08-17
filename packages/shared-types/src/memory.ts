/** Memory / RAG / knowledge-source contracts. Types only — no retrieve I/O. */

export const MEMORY_TIERS = [
  'org',
  'employee',
  'entity',
  'conversation',
  'working',
  'edge',
] as const;

export type MemoryTier = (typeof MEMORY_TIERS)[number];

export const ORG_MEMORY_KINDS = [
  'sop',
  'brand',
  'faq',
  'area_book',
  'policy',
  'fact',
  'preference',
  'summary',
  'note',
] as const;

export type OrgMemoryKind = (typeof ORG_MEMORY_KINDS)[number];

export const MEMORY_SOURCE_KINDS = [
  'drive',
  'notion',
  'upload',
  'pack',
  'gmail',
  'whatsapp',
  'slack',
  'crawl',
  'conversation',
  'sheets',
  'crm',
  'tool',
  'human',
  'web',
  'public_official',
] as const;

export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export const KNOWLEDGE_TRUST_CLASSES = [
  'sor',
  'communications',
  'documents',
  'licensed',
  'public_official',
  'web',
  'inference',
  'human',
] as const;

export type KnowledgeTrustClass = (typeof KNOWLEDGE_TRUST_CLASSES)[number];

export const KNOWLEDGE_SOURCE_STATUSES = [
  'pending',
  'syncing',
  'ready',
  'stale',
  'error',
  'disabled',
  'conflict',
] as const;

export type KnowledgeSourceStatus = (typeof KNOWLEDGE_SOURCE_STATUSES)[number];

export const INGESTION_JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type IngestionJobState = (typeof INGESTION_JOB_STATES)[number];

export const MEMORY_EDGE_RELS = [
  'inquired_about',
  'shown',
  'owns',
  'employs',
  'cites',
  'related_to',
  'supersedes',
] as const;

export type MemoryEdgeRel = (typeof MEMORY_EDGE_RELS)[number];

interface MemoryBase {
  id: string;
  orgId: string;
  body: string;
  embedding?: number[] | null;
  source: MemorySourceKind;
  sourceRef?: string | null;
  contentHash?: string | null;
  metadata?: Record<string, unknown>;
  expiresAt?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  invalidatedAt?: string | null;
  supersedesId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MemoryRecord =
  | (MemoryBase & {
      tier: 'org';
      kind: OrgMemoryKind;
      title?: string | null;
    })
  | (MemoryBase & {
      tier: 'employee';
      employeeId: string;
      kind?: OrgMemoryKind;
    })
  | (MemoryBase & {
      tier: 'entity';
      entityType: string;
      entityId: string;
      kind?: OrgMemoryKind;
    })
  | (MemoryBase & {
      tier: 'conversation';
      conversationId: string;
      summary: string;
    })
  | (MemoryBase & {
      tier: 'working';
      workItemId?: string;
      planId?: string;
    });

export interface MemoryEdge {
  id: string;
  orgId: string;
  fromId: string;
  toId: string;
  rel: MemoryEdgeRel;
  weight?: number;
  createdAt: string;
}

export interface KnowledgeSource {
  id: string;
  orgId: string;
  connector: string;
  path: string;
  hash: string;
  lastSynced?: string | null;
  status: KnowledgeSourceStatus;
  lastError?: string | null;
  documentCount?: number;
  trustClass?: KnowledgeTrustClass;
}

export interface IngestionJob {
  id: string;
  orgId: string;
  sourceId: string;
  state: IngestionJobState;
  cursor?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryCitation {
  id: string;
  tier: Exclude<MemoryTier, 'edge'>;
  snippet: string;
  source: MemorySourceKind;
  sourceRef?: string | null;
  stale: boolean;
  updatedAt: string;
}

export interface RetrieveMemoryRequest {
  orgId: string;
  query: string;
  employeeId?: string;
  conversationId?: string;
  workItemId?: string;
  entityType?: string;
  entityId?: string;
  tokenBudget?: number;
}

export interface RetrieveMemoryResult {
  orgId: string;
  citations: MemoryCitation[];
  emptyIndex: boolean;
}

export interface MemoryWriteBackFact {
  text: string;
  confidence: number;
  source: MemorySourceKind;
  sourceRef?: string | null;
  contentHash: string;
}

export interface MemoryFieldUpdate {
  entityType: string;
  entityId: string;
  field: string;
  value: unknown;
  confidence: number;
  confirmed: boolean;
}

export interface MemoryOpenQuestion {
  text: string;
  entityType?: string;
  entityId?: string;
}

export interface MemoryRelationExtract {
  fromId: string;
  toId: string;
  rel: MemoryEdgeRel;
  weight?: number;
}

export interface MemoryWriteBackPayload {
  facts: MemoryWriteBackFact[];
  fieldUpdates: MemoryFieldUpdate[];
  openQuestions: MemoryOpenQuestion[];
  relations: MemoryRelationExtract[];
}
