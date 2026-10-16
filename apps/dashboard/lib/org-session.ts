import { NextResponse } from 'next/server';

/** Stable code for suspended / soft-deleted workspace session denials. */
export const ORG_SUSPENDED_CODE = 'ORG_SUSPENDED';

/**
 * Thrown when the session org is suspended or soft-deleted.
 * Map via `scopedAuthErrorResponse` → HTTP 402.
 */
export class OrgSuspendedError extends Error {
  readonly code = ORG_SUSPENDED_CODE;
  readonly httpStatus = 402 as const;

  constructor(message = 'Workspace suspended') {
    super(message);
    this.name = 'OrgSuspendedError';
  }
}

export type OrgSessionOptions = {
  /**
   * When true, allow `suspended` orgs through (billing portal / paywall).
   * Soft-deleted workspaces are always refused.
   */
  allowSuspended?: boolean;
};

/**
 * Pure status gate for session tenancy. Soft-deleted always blocked;
 * suspended blocked unless `allowSuspended` (billing recovery).
 */
export function assertOrgSessionAllowed(
  status: string | null | undefined,
  options?: OrgSessionOptions
): void {
  const normalized = (status || 'active').trim().toLowerCase();
  if (normalized === 'soft_deleted') {
    throw new OrgSuspendedError('Workspace has been deleted');
  }
  if (normalized === 'suspended' && !options?.allowSuspended) {
    throw new OrgSuspendedError('Workspace suspended');
  }
}

export function isOrgSuspendedError(err: unknown): err is OrgSuspendedError {
  if (err instanceof OrgSuspendedError) return true;
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'OrgSuspendedError' ||
    err.message === 'Workspace suspended' ||
    err.message === 'Workspace has been deleted'
  );
}

/** Map getScopedClient auth failures to 401/402. Returns null for other errors. */
export function scopedAuthErrorResponse(err: unknown): NextResponse | null {
  if (isOrgSuspendedError(err)) {
    return NextResponse.json(
      { error: err.message || 'Workspace is suspended', code: ORG_SUSPENDED_CODE },
      { status: 402 }
    );
  }
  if (err instanceof Error && err.message === 'Unauthorized') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
