export const WORKSPACE_NAME_MAX = 80;
export const WORKSPACES_PER_USER_MAX = 10;

/** Trim and collapse whitespace; null when empty, too long, or has control chars. */
export function parseWorkspaceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (!name || name.length > WORKSPACE_NAME_MAX) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}
