/**
 * @jest-environment node
 *
 * Tenant suspension gate for getScopedClient — pure assert + HTTP mapper.
 * Body org_id is never consulted here (session-only tenancy).
 */

import { NextResponse } from 'next/server';
import {
  assertOrgSessionAllowed,
  isOrgSuspendedError,
  ORG_SUSPENDED_CODE,
  OrgSuspendedError,
  scopedAuthErrorResponse,
} from '../org-session';

describe('assertOrgSessionAllowed / scopedAuthErrorResponse', () => {
  it('allows active, provisioning, and past_due statuses', () => {
    expect(() => assertOrgSessionAllowed('active')).not.toThrow();
    expect(() => assertOrgSessionAllowed('provisioning')).not.toThrow();
    expect(() => assertOrgSessionAllowed('past_due')).not.toThrow();
    expect(() => assertOrgSessionAllowed('trialing')).not.toThrow();
    expect(() => assertOrgSessionAllowed(undefined)).not.toThrow();
  });

  it('rejects suspended orgs by default', () => {
    expect(() => assertOrgSessionAllowed('suspended')).toThrow(OrgSuspendedError);
    expect(() => assertOrgSessionAllowed('SUSPENDED')).toThrow(OrgSuspendedError);
  });

  it('allows suspended when allowSuspended is set (billing recovery)', () => {
    expect(() => assertOrgSessionAllowed('suspended', { allowSuspended: true })).not.toThrow();
  });

  it('always rejects soft_deleted even with allowSuspended', () => {
    expect(() => assertOrgSessionAllowed('soft_deleted', { allowSuspended: true })).toThrow(
      OrgSuspendedError
    );
  });

  it('maps OrgSuspendedError to HTTP 402 with stable code', async () => {
    const res = scopedAuthErrorResponse(new OrgSuspendedError());
    expect(res).toBeInstanceOf(NextResponse);
    expect(res!.status).toBe(402);
    const body = await res!.json();
    expect(body.code).toBe(ORG_SUSPENDED_CODE);
    expect(body.error).toMatch(/suspended/i);
  });

  it('maps Unauthorized to HTTP 401', async () => {
    const res = scopedAuthErrorResponse(new Error('Unauthorized'));
    expect(res!.status).toBe(401);
  });

  it('returns null for unrelated errors', () => {
    expect(scopedAuthErrorResponse(new Error('boom'))).toBeNull();
  });

  it('detects suspended errors by name/message without instanceof', () => {
    const plain = new Error('Workspace suspended');
    plain.name = 'OrgSuspendedError';
    expect(isOrgSuspendedError(plain)).toBe(true);
  });
});
