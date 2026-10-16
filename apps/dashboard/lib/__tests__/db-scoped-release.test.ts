/**
 * @jest-environment node
 *
 * Unit tests for releaseScopedClient / wrapClientRelease contract.
 * Does not need a live Postgres — mocks the PoolClient shape the helpers use.
 */

import type { PoolClient } from 'pg';

type DarexScopedClient = PoolClient & {
  _darexScoped?: boolean;
  _darexOriginalRelease?: (err?: Error | boolean) => void;
};

type ReleaseScoped = (client: PoolClient) => Promise<void>;

function mockScopedClient(overrides?: {
  queryImpl?: (sql: string) => Promise<unknown>;
}): DarexScopedClient {
  const originalRelease = jest.fn();
  const wrappedRelease = jest.fn();
  const query =
    overrides?.queryImpl ??
    (async () => ({ rows: [], rowCount: 0 }));

  return {
    query: jest.fn((sql: string) => query(sql)),
    release: wrappedRelease,
    _darexScoped: true,
    _darexOriginalRelease: originalRelease,
  } as unknown as DarexScopedClient;
}

describe('releaseScopedClient', () => {
  let releaseScopedClient: ReleaseScoped;

  beforeAll(async () => {
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test-rls-helper-unused';
    process.env.APP_DB_PASSWORD = process.env.APP_DB_PASSWORD || 'test-rls-helper-unused';
    ({ releaseScopedClient } = await import('../db'));
  });

  it('awaits RESET then calls native release — never the wrapped release', async () => {
    const client = mockScopedClient();
    const originalRelease = client._darexOriginalRelease as jest.Mock;
    const wrappedRelease = client.release as unknown as jest.Mock;

    await releaseScopedClient(client);

    expect(client.query).toHaveBeenCalledWith('RESET app.current_org_id');
    expect(client.query).toHaveBeenCalledWith('RESET app.current_user_id');
    expect(originalRelease).toHaveBeenCalledTimes(1);
    expect(originalRelease).toHaveBeenCalledWith();
    expect(wrappedRelease).not.toHaveBeenCalled();
    // Must stay true so wrapClientRelease on pool reuse does not double-wrap.
    expect(client._darexScoped).toBe(true);
  });

  it('destroys the client when RESET fails (does not silently return to pool)', async () => {
    const client = mockScopedClient({
      queryImpl: async () => {
        throw new Error('connection terminated');
      },
    });
    const originalRelease = client._darexOriginalRelease as jest.Mock;
    const wrappedRelease = client.release as unknown as jest.Mock;

    await releaseScopedClient(client);

    expect(originalRelease).toHaveBeenCalledTimes(1);
    const arg = originalRelease.mock.calls[0][0];
    expect(arg).toBeInstanceOf(Error);
    expect((arg as Error).message).toMatch(/connection terminated|Failed to reset session RLS/);
    expect(wrappedRelease).not.toHaveBeenCalled();
    expect(client._darexScoped).toBe(true);
  });
});

describe('wrapClientRelease on pool reuse', () => {
  it('re-wraps when pg-pool installs a fresh native release, so release is never stale', async () => {
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test-rls-helper-unused';
    process.env.APP_DB_PASSWORD = process.env.APP_DB_PASSWORD || 'test-rls-helper-unused';
    const { wrapClientRelease, releaseScopedClient } = await import('../db');

    const firstNative = jest.fn();
    const client = {
      query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
      release: firstNative,
    } as unknown as PoolClient;

    wrapClientRelease(client);
    client.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(firstNative).toHaveBeenCalledTimes(1);

    // Next checkout of the same object: pg-pool replaces release with a new native one.
    const secondNative = jest.fn();
    (client as { release: unknown }).release = secondNative;
    wrapClientRelease(client);
    expect(client.release).not.toBe(secondNative);

    await releaseScopedClient(client);
    expect(secondNative).toHaveBeenCalledTimes(1);
    expect(firstNative).toHaveBeenCalledTimes(1);
  });
});
