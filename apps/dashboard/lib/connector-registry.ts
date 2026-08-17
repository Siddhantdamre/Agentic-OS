/**
 * DB connector registry helpers (WS-07 / C3).
 *
 * `connector_defs` is the system of record for which apps exist (packs can
 * recommend a def without an org connection). `org_connectors` is a per-org
 * cache only — GET /api/integrations must still set `connected` from Nango
 * (OAuth) or verified BYOK keys, never from this table's status column.
 *
 * Callers pass a client from getScopedClient() / getOrgScopedClient(). Never
 * take org_id from a request body.
 */

import type { PoolClient } from 'pg';
import {
  INTEGRATION_CATALOG,
  type IntegrationAuthMode,
  type IntegrationCatalogItem,
  type IntegrationExecutorStatus,
  type IntegrationField,
} from '@/lib/integrations-catalog';

export const CONNECTOR_RISK_CLASSES = [
  'read',
  'draft',
  'send',
  'write_sor',
  'pay',
  'sign',
  'publish',
  'delete',
] as const;

export type ConnectorRiskClass = (typeof CONNECTOR_RISK_CLASSES)[number];
export type ConnectorConfirmPolicy = 'none' | 'confirm';

export const ORG_CONNECTOR_STATUSES = [
  'pending',
  'connected',
  'disconnected',
  'error',
  'disabled',
] as const;

export type OrgConnectorStatus = (typeof ORG_CONNECTOR_STATUSES)[number];

export interface ConnectorDef extends IntegrationCatalogItem {
  nangoKey: string | null;
  riskClass: ConnectorRiskClass;
  confirmPolicy: ConnectorConfirmPolicy;
  verticalTags: string[];
  mcpTools: string[];
}

export interface OrgConnector {
  connectorKey: string;
  status: OrgConnectorStatus;
  nangoConnectionId: string | null;
  scopes: string[];
  lastOkAt: string | null;
  lastError: string | null;
}

export interface SyncCursor {
  connectorKey: string;
  stream: string;
  cursor: string | null;
  updatedAt: string | null;
}

interface ConnectorRegistryMeta {
  nangoKey: string | null;
  riskClass: ConnectorRiskClass;
  verticalTags: string[];
  mcpTools: string[];
}

/**
 * Risk / MCP / vertical tags for today's 27 catalog apps.
 * Highest action class wins (gmail draft+send → send).
 */
export const CONNECTOR_REGISTRY_META: Record<string, ConnectorRegistryMeta> = {
  whatsapp: {
    nangoKey: 'whatsapp',
    riskClass: 'send',
    verticalTags: ['core', 'messaging'],
    mcpTools: ['whatsapp_send'],
  },
  gmail: {
    nangoKey: 'gmail',
    riskClass: 'send',
    verticalTags: ['core', 'email'],
    mcpTools: [
      'gmail_fetch',
      'gmail_send',
      'gmail_triage',
      'gmail_extract_otp',
      'gmail_extract_attachment',
      'gmail_draft_email',
    ],
  },
  'google-calendar': {
    nangoKey: 'google-calendar',
    riskClass: 'write_sor',
    verticalTags: ['core', 'calendar'],
    mcpTools: ['calendar_list_events', 'calendar_create_event', 'calendar_check_availability'],
  },
  'google-ads': {
    nangoKey: 'google-ads',
    riskClass: 'publish',
    verticalTags: ['core', 'ads'],
    mcpTools: ['google_ads_metrics'],
  },
  'meta-ads': {
    nangoKey: 'meta-ads',
    riskClass: 'publish',
    verticalTags: ['core', 'ads'],
    mcpTools: ['meta_ads_metrics'],
  },
  hubspot: {
    nangoKey: 'hubspot',
    riskClass: 'write_sor',
    verticalTags: ['core', 'crm'],
    mcpTools: ['hubspot_create_contact', 'hubspot_update_contact'],
  },
  stripe: {
    nangoKey: 'stripe',
    riskClass: 'pay',
    verticalTags: ['core', 'payments'],
    mcpTools: ['stripe_create_payment_link', 'stripe_create_customer', 'stripe_get_customer'],
  },
  notion: {
    nangoKey: 'notion',
    riskClass: 'write_sor',
    verticalTags: ['core', 'knowledge'],
    mcpTools: ['notion_create_page', 'notion_append_page_content', 'notion_search'],
  },
  slack: {
    nangoKey: 'slack',
    riskClass: 'send',
    verticalTags: ['core', 'messaging'],
    mcpTools: ['slack_send'],
  },
  shopify: {
    nangoKey: 'shopify',
    riskClass: 'write_sor',
    verticalTags: ['core', 'ecommerce'],
    mcpTools: ['shopify_fetch_products', 'shopify_fetch_orders'],
  },
  zendesk: {
    nangoKey: 'zendesk',
    riskClass: 'write_sor',
    verticalTags: ['core', 'support'],
    mcpTools: ['zendesk_fetch_tickets', 'zendesk_create_ticket', 'zendesk_update_ticket'],
  },
  intercom: {
    nangoKey: 'intercom',
    riskClass: 'send',
    verticalTags: ['core', 'support'],
    mcpTools: ['intercom_fetch_conversations', 'intercom_reply', 'intercom_create_conversation'],
  },
  github: {
    nangoKey: 'github',
    riskClass: 'write_sor',
    verticalTags: ['core', 'development'],
    mcpTools: ['github_fetch_repos', 'github_create_repo', 'github_create_issue'],
  },
  razorpay: {
    nangoKey: 'razorpay',
    riskClass: 'pay',
    verticalTags: ['core', 'payments'],
    mcpTools: ['razorpay_create_payment_link'],
  },
  'google-drive': {
    nangoKey: 'google-drive',
    riskClass: 'write_sor',
    verticalTags: ['core', 'productivity'],
    mcpTools: ['drive_search', 'drive_list', 'drive_get_text', 'drive_upload', 'drive_share'],
  },
  'google-docs': {
    nangoKey: 'google-docs',
    riskClass: 'write_sor',
    verticalTags: ['core', 'productivity'],
    mcpTools: ['docs_create', 'docs_read', 'docs_append'],
  },
  'google-sheets': {
    nangoKey: 'google-sheets',
    riskClass: 'write_sor',
    verticalTags: ['core', 'productivity'],
    mcpTools: ['sheets_create', 'sheets_read', 'sheets_append_row'],
  },
  'google-slides': {
    nangoKey: 'google-slides',
    riskClass: 'publish',
    verticalTags: ['core', 'productivity'],
    mcpTools: ['slides_create'],
  },
  'google-forms': {
    nangoKey: 'google-forms',
    riskClass: 'read',
    verticalTags: ['core', 'productivity'],
    mcpTools: ['forms_get'],
  },
  'google-chat': {
    nangoKey: 'google-chat',
    riskClass: 'send',
    verticalTags: ['core', 'messaging'],
    mcpTools: ['chat_list_spaces', 'chat_send_message'],
  },
  'google-meet': {
    nangoKey: 'google-meet',
    riskClass: 'write_sor',
    verticalTags: ['core', 'meetings'],
    mcpTools: ['meet_create_space', 'meet_get_space'],
  },
  'google-contacts': {
    nangoKey: 'google-contacts',
    riskClass: 'write_sor',
    verticalTags: ['core', 'contacts'],
    mcpTools: ['contacts_list'],
  },
  'google-tasks': {
    nangoKey: 'google-tasks',
    riskClass: 'write_sor',
    verticalTags: ['core', 'productivity'],
    mcpTools: ['tasks_list'],
  },
  'google-analytics': {
    nangoKey: 'google-analytics',
    riskClass: 'read',
    verticalTags: ['core', 'analytics'],
    mcpTools: ['analytics_report'],
  },
  'google-search-console': {
    nangoKey: 'google-search-console',
    riskClass: 'read',
    verticalTags: ['core', 'seo'],
    mcpTools: ['search_console_sites', 'search_console_query'],
  },
  'google-business-profile': {
    nangoKey: 'google-business-profile',
    riskClass: 'publish',
    verticalTags: ['core', 'marketing'],
    mcpTools: ['business_list_locations'],
  },
  'google-cloud': {
    nangoKey: 'google-cloud',
    riskClass: 'read',
    verticalTags: ['core', 'infrastructure'],
    mcpTools: ['cloud_list_projects'],
  },
};

export function confirmPolicyFor(risk: ConnectorRiskClass): ConnectorConfirmPolicy {
  switch (risk) {
    case 'read':
    case 'draft':
      return 'none';
    case 'send':
    case 'write_sor':
    case 'pay':
    case 'delete':
    case 'publish':
    case 'sign':
      return 'confirm';
    default: {
      const _exhaustive: never = risk;
      return _exhaustive;
    }
  }
}

function pgCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    return (err as { code: string }).code;
  }
  return undefined;
}

function isMissingRelation(err: unknown): boolean {
  return pgCode(err) === '42P01';
}

function isFkViolation(err: unknown): boolean {
  return pgCode(err) === '23503';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v));
}

function asFields(value: unknown): IntegrationField[] {
  if (!Array.isArray(value)) return [];
  return value as IntegrationField[];
}

function asAuthMode(value: unknown): IntegrationAuthMode {
  if (value === 'oauth' || value === 'api_key' || value === 'byok' || value === 'service_account') {
    return value;
  }
  return 'oauth';
}

function asExecutorStatus(value: unknown): IntegrationExecutorStatus {
  return value === 'catalog_only' ? 'catalog_only' : 'live';
}

function asRiskClass(value: unknown): ConnectorRiskClass {
  if (typeof value === 'string' && (CONNECTOR_RISK_CLASSES as readonly string[]).includes(value)) {
    return value as ConnectorRiskClass;
  }
  return 'read';
}

function asConfirmPolicy(value: unknown): ConnectorConfirmPolicy {
  return value === 'confirm' ? 'confirm' : 'none';
}

function asOrgConnectorStatus(value: unknown): OrgConnectorStatus {
  if (typeof value === 'string' && (ORG_CONNECTOR_STATUSES as readonly string[]).includes(value)) {
    return value as OrgConnectorStatus;
  }
  return 'disconnected';
}

function catalogItemToDef(item: IntegrationCatalogItem): ConnectorDef {
  const meta = CONNECTOR_REGISTRY_META[item.id];
  const riskClass = meta?.riskClass ?? 'read';
  return {
    ...item,
    nangoKey: meta?.nangoKey ?? item.id,
    riskClass,
    confirmPolicy: confirmPolicyFor(riskClass),
    verticalTags: meta?.verticalTags ?? ['core'],
    mcpTools: meta?.mcpTools ?? [],
  };
}

function catalogAsDefs(): ConnectorDef[] {
  return INTEGRATION_CATALOG.map(catalogItemToDef);
}

function rowToDef(row: Record<string, unknown>): ConnectorDef {
  const key = String(row.key);
  const riskClass = asRiskClass(row.risk_class);
  return {
    id: key,
    name: String(row.name ?? key),
    category: String(row.category ?? ''),
    icon: String(row.icon ?? ''),
    desc: String(row.description ?? ''),
    authMode: asAuthMode(row.auth_mode),
    extraConnectFields: asFields(row.extra_connect_fields),
    extraTestFields: asFields(row.extra_test_fields),
    executorStatus: asExecutorStatus(row.executor_status),
    testable: Boolean(row.testable),
    scopes: asStringArray(row.scopes),
    envVars: Array.isArray(row.env_vars) ? (row.env_vars as Array<{ name: string; desc: string }>) : [],
    webhookEvents: asStringArray(row.webhook_events),
    operatorHint: row.operator_hint ? String(row.operator_hint) : undefined,
    nangoKey: row.nango_key == null ? null : String(row.nango_key),
    riskClass,
    confirmPolicy: asConfirmPolicy(row.confirm_policy) || confirmPolicyFor(riskClass),
    verticalTags: asStringArray(row.vertical_tags),
    mcpTools: asStringArray(row.mcp_tools),
  };
}

const DEF_SELECT = `
  SELECT key, nango_key, name, category, icon, description, auth_mode,
         risk_class, confirm_policy, vertical_tags, mcp_tools,
         extra_connect_fields, extra_test_fields, executor_status, testable,
         scopes, env_vars, webhook_events, operator_hint, sort_order
    FROM connector_defs
`;

async function insertDef(client: PoolClient, def: ConnectorDef, sortOrder: number): Promise<void> {
  await client.query(
    `INSERT INTO connector_defs (
       key, nango_key, name, category, icon, description, auth_mode,
       risk_class, confirm_policy, vertical_tags, mcp_tools,
       extra_connect_fields, extra_test_fields, executor_status, testable,
       scopes, env_vars, webhook_events, operator_hint, sort_order
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10::text[], $11::text[],
       $12::jsonb, $13::jsonb, $14, $15,
       $16::text[], $17::jsonb, $18::text[], $19, $20
     )
     ON CONFLICT (key) DO NOTHING`,
    [
      def.id,
      def.nangoKey,
      def.name,
      def.category,
      def.icon,
      def.desc,
      def.authMode,
      def.riskClass,
      def.confirmPolicy,
      def.verticalTags,
      def.mcpTools,
      JSON.stringify(def.extraConnectFields),
      JSON.stringify(def.extraTestFields),
      def.executorStatus,
      def.testable,
      def.scopes,
      JSON.stringify(def.envVars),
      def.webhookEvents,
      def.operatorHint ?? null,
      sortOrder,
    ]
  );
}

/** Bootstrap defs from the TS catalog when the table exists but is empty. */
export async function ensureConnectorDefsSeeded(client: PoolClient): Promise<void> {
  try {
    const count = await client.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM connector_defs');
    if (Number(count.rows[0]?.n) > 0) return;
    const defs = catalogAsDefs();
    for (let i = 0; i < defs.length; i++) {
      await insertDef(client, defs[i], i + 1);
    }
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }
}

export async function listConnectorDefs(client: PoolClient): Promise<ConnectorDef[]> {
  try {
    await ensureConnectorDefsSeeded(client);
    const res = await client.query(`${DEF_SELECT} ORDER BY sort_order ASC, key ASC`);
    if (res.rows.length === 0) return catalogAsDefs();
    return res.rows.map((row) => rowToDef(row as Record<string, unknown>));
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
    return catalogAsDefs();
  }
}

export async function getConnectorDef(client: PoolClient, key: string): Promise<ConnectorDef | undefined> {
  try {
    await ensureConnectorDefsSeeded(client);
    const res = await client.query(`${DEF_SELECT} WHERE key = $1`, [key]);
    if (res.rows[0]) return rowToDef(res.rows[0] as Record<string, unknown>);
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }
  const fallback = INTEGRATION_CATALOG.find((item) => item.id === key);
  return fallback ? catalogItemToDef(fallback) : undefined;
}

export async function isKnownConnector(client: PoolClient, key: string): Promise<boolean> {
  return Boolean(await getConnectorDef(client, key));
}

export async function listOrgConnectors(
  client: PoolClient,
  orgId: string
): Promise<Map<string, OrgConnector>> {
  const out = new Map<string, OrgConnector>();
  try {
    const res = await client.query(
      `SELECT connector_key, status, nango_connection_id, scopes, last_ok_at, last_error
         FROM org_connectors WHERE org_id = $1`,
      [orgId]
    );
    for (const row of res.rows) {
      const connectorKey = String(row.connector_key);
      out.set(connectorKey, {
        connectorKey,
        status: asOrgConnectorStatus(row.status),
        nangoConnectionId: row.nango_connection_id ? String(row.nango_connection_id) : null,
        scopes: asStringArray(row.scopes),
        lastOkAt: row.last_ok_at ? String(row.last_ok_at) : null,
        lastError: row.last_error ? String(row.last_error) : null,
      });
    }
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }
  return out;
}

export async function upsertOrgConnector(
  client: PoolClient,
  orgId: string,
  connectorKey: string,
  fields: {
    status: OrgConnectorStatus;
    nangoConnectionId?: string | null;
    scopes?: string[];
    lastOkAt?: Date | string | null;
    lastError?: string | null;
  }
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO org_connectors (
         org_id, connector_key, status, nango_connection_id, scopes, last_ok_at, last_error, updated_at
       ) VALUES ($1, $2, $3, $4, $5::text[], $6, $7, NOW())
       ON CONFLICT (org_id, connector_key)
       DO UPDATE SET
         status = EXCLUDED.status,
         nango_connection_id = EXCLUDED.nango_connection_id,
         scopes = EXCLUDED.scopes,
         last_ok_at = EXCLUDED.last_ok_at,
         last_error = EXCLUDED.last_error,
         updated_at = NOW()`,
      [
        orgId,
        connectorKey,
        fields.status,
        fields.nangoConnectionId ?? null,
        fields.scopes ?? [],
        fields.lastOkAt ?? null,
        fields.lastError ?? null,
      ]
    );
  } catch (err) {
    if (!isMissingRelation(err) && !isFkViolation(err)) throw err;
  }
}

export async function getSyncCursor(
  client: PoolClient,
  orgId: string,
  connectorKey: string,
  stream: string
): Promise<SyncCursor | null> {
  try {
    const res = await client.query(
      `SELECT connector_key, stream, cursor, updated_at
         FROM sync_cursors
        WHERE org_id = $1 AND connector_key = $2 AND stream = $3`,
      [orgId, connectorKey, stream]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      connectorKey: String(row.connector_key),
      stream: String(row.stream),
      cursor: row.cursor == null ? null : String(row.cursor),
      updatedAt: row.updated_at ? String(row.updated_at) : null,
    };
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
    return null;
  }
}

export async function upsertSyncCursor(
  client: PoolClient,
  orgId: string,
  connectorKey: string,
  stream: string,
  cursor: string
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO sync_cursors (org_id, connector_key, stream, cursor, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (org_id, connector_key, stream)
       DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = NOW()`,
      [orgId, connectorKey, stream, cursor]
    );
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }
}
