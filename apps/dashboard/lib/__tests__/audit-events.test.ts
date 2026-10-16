/**
 * @jest-environment node
 *
 * Unit tests for recordAuditEvent — INSERT-only, session-org scoped.
 * Mocks @/lib/db so the suite does not need a live Postgres or workflows dist.
 */

import type { PoolClient } from 'pg';

jest.mock('@/lib/db', () => ({
  getOrgScopedClient: jest.fn(),
}));

import {
  AUDIT_EVENT_INSERT_SQL,
  AUDIT_EVENT_KINDS,
  recordAuditEvent,
} from '../audit-events';

function mockClient(): PoolClient & { query: jest.Mock } {
  return {
    query: jest.fn(async () => ({ rows: [], rowCount: 1 })),
    release: jest.fn(),
  } as unknown as PoolClient & { query: jest.Mock };
}

describe('recordAuditEvent', () => {
  it('INSERT-only SQL contains no UPDATE or DELETE', () => {
    const sql = AUDIT_EVENT_INSERT_SQL.replace(/\s+/g, ' ').toUpperCase();
    expect(sql.startsWith('INSERT INTO AUDIT_EVENTS')).toBe(true);
    expect(sql).not.toMatch(/\bUPDATE\b/);
    expect(sql).not.toMatch(/\bDELETE\b/);
  });

  it('writes one INSERT scoped to the session orgId', async () => {
    const client = mockClient();
    const orgId = '11111111-1111-1111-1111-111111111111';
    const userId = '22222222-2222-2222-2222-222222222222';

    await recordAuditEvent(
      {
        orgId,
        kind: 'settings.update',
        actor: { actorType: 'user', userId },
        action: 'kill_switch.toggle',
        resultStatus: 'ok',
        riskClass: 'critical',
        payload: { enabled: true },
      },
      { client, orgId }
    );

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe(AUDIT_EVENT_INSERT_SQL);
    expect(params[0]).toBe(orgId);
    expect(params[1]).toBe('settings.update');
    expect(params[2]).toBe('user');
    expect(params[3]).toBe(userId);
    expect(params[11]).toBe('kill_switch.toggle');
    expect(params[16]).toBe('ok');

    const allSql = client.query.mock.calls.map((c) => String(c[0]).toUpperCase()).join('\n');
    expect(allSql).not.toMatch(/\bUPDATE\b/);
    expect(allSql).not.toMatch(/\bDELETE\b/);
  });

  it('AUDIT_EVENT_KINDS matches the newest audit_events_kind_chk migration', () => {
    // A kind the CHECK rejects makes the INSERT throw; this pins the TS union
    // to the constraint so a route cannot emit a kind the DB refuses.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const dir = path.resolve(__dirname, '../../../../infra/db/migrations');
    const latest = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) =>
        /ADD CONSTRAINT audit_events_kind_chk/.test(fs.readFileSync(path.join(dir, f), 'utf8'))
      )
      .pop();
    expect(latest).toBeDefined();
    const sql = fs.readFileSync(path.join(dir, latest as string), 'utf8');
    const block = sql.slice(sql.indexOf('ADD CONSTRAINT audit_events_kind_chk'));
    const body = block.slice(0, block.indexOf('));'));
    const dbKinds = Array.from(body.matchAll(/'([a-z_]+\.[a-z_]+|login|register|logout)'/g)).map(
      (m) => m[1]
    );
    expect([...dbKinds].sort()).toEqual([...AUDIT_EVENT_KINDS].sort());
  });

  it('rejects when params.orgId does not match scoped client org', async () => {
    const client = mockClient();
    await expect(
      recordAuditEvent(
        {
          orgId: '11111111-1111-1111-1111-111111111111',
          kind: 'member.invite',
          actor: { actorType: 'user', userId: '22222222-2222-2222-2222-222222222222' },
          resultStatus: 'ok',
        },
        { client, orgId: '33333333-3333-3333-3333-333333333333' }
      )
    ).rejects.toThrow(/orgId does not match scoped client/);
    expect(client.query).not.toHaveBeenCalled();
  });
});
