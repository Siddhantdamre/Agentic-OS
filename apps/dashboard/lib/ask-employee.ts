import { route, type RouteEmployee } from '@darex/workflows/dist/route-employee';
import { filterAllowlistForPersona } from '@/lib/role-scoped-tools';

export interface AskEmployee {
  id?: string;
  name: string;
  role: string;
  persona: string;
  tools: string[];
  reason: string;
}

/** Mirrors workflows CORE_READ_TOOLS. Code execution and file writes are opt-in on the card. */
const CORE_TOOLS = [
  'web_search', 'search', 'google_search',
  'web_extract', 'fetch_url', 'read_url',
  'database_query', 'db_query', 'sql_analytics',
  'metrics', 'metrics_query',
  'cognee_search',
] as const;

export function personaPlain(raw: unknown): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { text?: unknown };
        if (typeof parsed?.text === 'string' && parsed.text.trim()) return parsed.text.trim();
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (raw && typeof raw === 'object' && typeof (raw as { text?: unknown }).text === 'string') {
    return String((raw as { text: string }).text);
  }
  return '';
}

function allowlistPlain(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => String(item));
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
    } catch {
      return raw.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

/**
 * Connected channels that also appear on the employee card.
 * Empty card → no connectors (core tools only).
 */
export function channelsOnEmployeeCard(
  employeeTools: string[],
  connectedChannels: string[],
): string[] {
  const cardKeys = new Set(
    (employeeTools || []).map(normalizeKey).filter(Boolean),
  );
  if (cardKeys.size === 0) return [];
  return (connectedChannels || []).filter((ch) => {
    const key = normalizeKey(ch);
    if (!key) return false;
    if (cardKeys.has(key)) return true;
    for (const tool of cardKeys) {
      if (key.startsWith(`${tool}-`) || tool.startsWith(`${key}-`)) return true;
    }
    return false;
  });
}

/** Pure merge: core ∪ employee tools ∪ channels (no org peer union). */
export function mergeCardAllowlist(
  employeeTools: string[],
  channels: string[],
  role: string | undefined,
): string[] {
  const union = new Set<string>(CORE_TOOLS.map(normalizeKey));
  for (const t of employeeTools || []) {
    const key = normalizeKey(t);
    if (key) union.add(key);
  }
  for (const t of channels || []) {
    const key = normalizeKey(t);
    if (key) union.add(key);
  }
  return filterAllowlistForPersona(Array.from(union).filter(Boolean), role);
}

export function routeAskEmployee(
  orgId: string,
  message: string,
  rows: Array<{
    id?: string;
    name?: string;
    role?: string;
    persona?: unknown;
    tool_allowlist?: unknown;
    status?: string;
  }>,
): AskEmployee | null {
  const employees: RouteEmployee[] = rows
    .filter((row) => row.id && row.name)
    .map((row) => ({
      id: String(row.id),
      name: String(row.name),
      role: String(row.role || ''),
      persona: personaPlain(row.persona),
      toolAllowlist: allowlistPlain(row.tool_allowlist),
      status: row.status === 'paused' ? 'paused' : 'active',
    }));

  const result = route({ orgId, userMessage: message, employees });
  if (result.destination !== 'employee' || !result.employeeName) return null;
  return {
    id: result.employeeId,
    name: result.employeeName,
    role: result.employeeRole,
    persona: result.employeePersona,
    tools: result.toolAllowlist,
    reason: result.reason,
  };
}

export function allowlistPlainPublic(raw: unknown): string[] {
  return allowlistPlain(raw);
}

/** Org-union tools, then put this employee's own tools back so persona filters cannot drop them. */
export function allowlistForEmployeeTurn(
  employeeTools: string[],
  orgTools: string[],
  connectedChannels: string[],
  role: string | undefined,
): string[] {
  const merged = mergeCardAllowlist([...orgTools, ...employeeTools], connectedChannels, role);
  const keys = new Set<string>(merged);
  for (const tool of employeeTools) {
    const key = normalizeKey(tool);
    if (key) keys.add(key);
  }
  return Array.from(keys);
}

/**
 * Locked single/team path (and auto when a specific employee is selected):
 * ONLY this employee's allowlist + core + connected channels that are on the card.
 * Never unions the rest of the org — picking / locking must not widen permissions.
 * Empty allowlist → core tools only (no stripe/gmail just because the org connected them).
 */
export function allowlistForLockedEmployeeTurn(
  employeeTools: string[],
  connectedChannels: string[],
  role: string | undefined,
): string[] {
  const channelsOnCard = channelsOnEmployeeCard(employeeTools, connectedChannels);
  const merged = mergeCardAllowlist(employeeTools, channelsOnCard, role);
  const keys = new Set<string>(merged);
  for (const tool of employeeTools) {
    const key = normalizeKey(tool);
    if (key) keys.add(key);
  }
  return Array.from(keys);
}
