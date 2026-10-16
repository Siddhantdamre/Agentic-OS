/**
 * Typed confirmation for irreversible DSR delete.
 * Caller must type the org slug (preferred) or exact org name.
 */

export function normalizeConfirmPhrase(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

export function matchesDsrDeleteConfirm(params: {
  confirm: unknown;
  orgSlug: string | null | undefined;
  orgName: string | null | undefined;
}): boolean {
  const typed = normalizeConfirmPhrase(params.confirm);
  if (!typed) return false;
  const slug = normalizeConfirmPhrase(params.orgSlug);
  const name = normalizeConfirmPhrase(params.orgName);
  if (slug && typed === slug) return true;
  if (name && typed === name) return true;
  return false;
}
