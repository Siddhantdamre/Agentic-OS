/**
 * Allowed Google Workspace hosted domain. Fail closed: no default. Operators
 * must set GOOGLE_WORKSPACE_HD to a domain, or to '*' to explicitly accept any
 * Workspace domain.
 */
export function googleWorkspaceHd(): string | null {
  const hd = (process.env.GOOGLE_WORKSPACE_HD || '').trim();
  return hd || null;
}
