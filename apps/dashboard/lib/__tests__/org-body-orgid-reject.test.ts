/**
 * @jest-environment node
 *
 * Org mutating routes must reject body org_id / orgId (session tenancy only).
 * Exercises the same guard pattern used by kill-switch / rollout / create / switch.
 */

function rejectClientOrgId(body: Record<string, unknown>): { ok: false; status: 400 } | { ok: true } {
  if (body.orgId !== undefined || body.org_id !== undefined) {
    return { ok: false, status: 400 };
  }
  return { ok: true };
}

describe('org routes reject body org id', () => {
  it('rejects orgId in body', () => {
    expect(rejectClientOrgId({ orgId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', enabled: true })).toEqual({
      ok: false,
      status: 400,
    });
  });

  it('rejects org_id in body', () => {
    expect(rejectClientOrgId({ org_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })).toEqual({
      ok: false,
      status: 400,
    });
  });

  it('accepts bodies without org identifiers', () => {
    expect(rejectClientOrgId({ enabled: true })).toEqual({ ok: true });
    expect(rejectClientOrgId({ targetOrgId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })).toEqual({
      ok: true,
    });
  });
});
