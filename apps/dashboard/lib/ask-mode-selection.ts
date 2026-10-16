/** Pure selection helpers for Ask AI Auto / Pick one / Team mode. */

export type AskMode = 'auto' | 'single' | 'team';

export const TEAM_EMPLOYEE_CAP = 3;

export interface AskEmployeeOption {
  id: string;
  name: string;
  role: string;
  /** Optional image URL; UI falls back to initials. */
  avatarUrl?: string | null;
  /** Count shown next to the employee (connected tools or allowlist size). */
  toolCount: number;
  /** Label for toolCount — never invent connection status. */
  toolCountLabel: 'connected' | 'tools';
  status: string;
}

export interface AskRouting {
  mode: AskMode;
  employeeIds: string[];
  employeeNames: string[];
  reason: string;
  overriddenByMention: boolean;
  fallbackNotice?: string;
}

const ALWAYS_READY = new Set([
  'web_search',
  'web_extract',
  'database_query',
  'knowledge_search',
  'metrics',
  'file_ops',
  'code_execution',
]);

export function normalizeAskMode(raw: unknown): AskMode {
  if (raw === 'single' || raw === 'team' || raw === 'auto') return raw;
  return 'auto';
}

export function parseToolAllowlist(tools: unknown): string[] {
  if (Array.isArray(tools)) {
    return tools.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
  }
  if (typeof tools === 'string') {
    const trimmed = tools.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
      }
    } catch {
      // comma-separated fallback
    }
    return trimmed
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

function channelMatchesTool(channel: string, tool: string): boolean {
  const ch = channel.toLowerCase().replace(/_/g, '-');
  const key = tool.toLowerCase().replace(/_/g, '-');
  return ch === key || ch.startsWith(`${key}-`) || key.startsWith(`${ch}-`);
}

export function isToolConnected(tool: string, connectedChannels: string[]): boolean {
  const lower = tool.toLowerCase();
  const key = lower.replace(/_/g, '-');
  if (ALWAYS_READY.has(lower) || ALWAYS_READY.has(key)) return true;
  return connectedChannels.some((channel) => channelMatchesTool(channel, tool));
}

/**
 * Prefer a real connected count when the org's connected channel list is known.
 * If channels are unavailable, fall back to allowlist length labeled "tools".
 */
export function deriveToolCount(
  allowlist: unknown,
  connectedChannels: string[] | null | undefined
): { count: number; label: 'connected' | 'tools' } {
  const tools = parseToolAllowlist(allowlist);
  if (connectedChannels == null) {
    return { count: tools.length, label: 'tools' };
  }
  const connected = tools.filter((t) => isToolConnected(t, connectedChannels)).length;
  return { count: connected, label: 'connected' };
}

export function filterEmployeesBySearch(
  employees: AskEmployeeOption[],
  query: string
): AskEmployeeOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return employees;
  return employees.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.role.toLowerCase().includes(q)
  );
}

/**
 * Toggle an id in a team selection. Hard-caps at `cap` (default 3):
 * adding when already at cap is a no-op.
 */
export function toggleTeamSelection(
  currentIds: string[],
  id: string,
  cap: number = TEAM_EMPLOYEE_CAP
): { ids: string[]; atCap: boolean; added: boolean } {
  if (currentIds.includes(id)) {
    const ids = currentIds.filter((x) => x !== id);
    return { ids, atCap: ids.length >= cap, added: false };
  }
  if (currentIds.length >= cap) {
    return { ids: currentIds, atCap: true, added: false };
  }
  const ids = [...currentIds, id];
  return { ids, atCap: ids.length >= cap, added: true };
}

/** Ids to send with the Ask AI POST for the current mode. */
export function employeeIdsForRequest(mode: AskMode, selectedIds: string[]): string[] {
  switch (mode) {
    case 'auto':
      return [];
    case 'single':
      return selectedIds.slice(0, 1);
    case 'team':
      return selectedIds.slice(0, TEAM_EMPLOYEE_CAP);
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

export function parseAskRouting(raw: unknown): AskRouting | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const mode = normalizeAskMode(r.mode);
  const employeeIds = Array.isArray(r.employeeIds)
    ? r.employeeIds.filter((id): id is string => typeof id === 'string')
    : [];
  const employeeNames = Array.isArray(r.employeeNames)
    ? r.employeeNames.filter((n): n is string => typeof n === 'string')
    : [];
  const reason = typeof r.reason === 'string' ? r.reason : '';
  const overriddenByMention = r.overriddenByMention === true;
  const fallbackNotice =
    typeof r.fallbackNotice === 'string' && r.fallbackNotice.trim()
      ? r.fallbackNotice.trim()
      : undefined;
  return {
    mode,
    employeeIds,
    employeeNames,
    reason,
    overriddenByMention,
    fallbackNotice,
  };
}

export function employeeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ''}${parts[parts.length - 1][0] || ''}`.toUpperCase();
}
