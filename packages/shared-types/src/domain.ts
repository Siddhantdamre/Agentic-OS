/** Shared domain shapes. Callers: dashboard + workflows. Not a DB schema. */

export type OrgPlan = 'free' | 'starter' | 'growth' | 'enterprise' | string;
export type OrgStatus = 'provisioning' | 'active' | 'paused' | 'deleted' | string;
export type UserRole = 'owner' | 'admin' | 'member' | string;
export type EmployeeStatus = 'active' | 'paused' | 'archived' | string;
export type ChannelStatus = 'connected' | 'active' | 'disconnected' | 'error' | string;
export type ConversationStatus = 'open' | 'needs_attention' | 'resolved' | 'closed' | string;
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'customer' | 'agent' | string;

export interface Org {
  id: string;
  name: string;
  slug: string;
  plan: OrgPlan;
  status: OrgStatus;
  meta?: Record<string, unknown>;
}

export interface User {
  id: string;
  org_id: string | null;
  email: string;
  role: UserRole;
  password_hash?: string | null;
  supertokens_id?: string | null;
}

export interface AIEmployee {
  id: string;
  org_id: string;
  name: string;
  role: string;
  persona: Record<string, unknown> | string;
  tool_allowlist: string[];
  graph_id: string;
  status: EmployeeStatus;
}

export interface Channel {
  id: string;
  org_id: string;
  channel_type: string;
  status: ChannelStatus;
  nango_connection_id?: string | null;
  meta?: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  org_id: string;
  employee_id?: string | null;
  channel_id?: string | null;
  chatwoot_conv_id?: string | null;
  status: ConversationStatus;
  contact?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

export interface Message {
  id: string;
  org_id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  tool_calls?: unknown;
  chatwoot_msg_id?: string | null;
}

export const CORE_TOOLS = [
  'web_search',
  'web_extract',
  'database_query',
  'file_ops',
  'sandbox',
  'code_execution',
] as const;

export type CoreTool = (typeof CORE_TOOLS)[number];
