/**
 * @jest-environment node
 */
jest.mock('@/lib/connector-rbac', () => ({ auditConnectorChange: jest.fn() }));
jest.mock('@/lib/connector-registry', () => ({ upsertOrgConnector: jest.fn() }));

import type { PoolClient } from 'pg';
import { isChannelId, newAccountKey, promoteWhatsAppPrimary, publicWhatsAppNumber, resolveConnectSlot } from '../whatsapp-numbers';

const ID = '11111111-2222-3333-4444-555555555555';
const client = (rows: unknown[]) => ({ query: jest.fn(async () => ({ rows })) }) as unknown as PoolClient;

describe('whatsapp numbers', () => {
  it('accepts only uuids as channel ids', () => {
    expect(isChannelId(ID)).toBe(true);
    expect(isChannelId('abc')).toBe(false);
    expect(isChannelId("x'; drop table channels;--")).toBe(false);
    expect(isChannelId(undefined)).toBe(false);
  });

  it('makes a short, different key for each extra number', () => {
    const a = newAccountKey();
    expect(a).toMatch(/^n[0-9a-f]{6}$/);
    expect(newAccountKey()).not.toBe(a);
  });

  it('connects to the primary by default, a new key with add, and the named number by id', async () => {
    expect(await resolveConnectSlot(client([]), 'o', {})).toEqual({ ok: true, accountKey: '' });
    const added = await resolveConnectSlot(client([]), 'o', { add: true });
    expect(added.ok && added.accountKey).toMatch(/^n/);
    expect(await resolveConnectSlot(client([{ id: ID, account_key: 'n1' }]), 'o', { channelId: ID })).toEqual({
      ok: true,
      accountKey: 'n1',
    });
  });

  it('refuses a channel id that is not this org\'s number', async () => {
    const r = await resolveConnectSlot(client([]), 'o', { channelId: ID });
    expect(r.ok).toBe(false);
  });

  it('shows a number without any token', () => {
    const n = publicWhatsAppNumber({
      id: ID,
      account_key: 'n1',
      status: 'connected',
      connected_at: null,
      meta: { provider: 'meta-cloud', accessToken: 'enc:v1.secret', display_phone_number: '+91 98123 45678', verified_name: 'Acme' },
    });
    expect(n).toMatchObject({ id: ID, primary: false, provider: 'meta-cloud', connected: true, phone: '+91 98123 45678', name: 'Acme' });
    expect(JSON.stringify(n)).not.toContain('secret');
  });

  describe('promoteWhatsAppPrimary', () => {
    const fake = (rows: Array<{ id: string; account_key: string; status: string }>) => {
      const updates: Array<[string, string]> = [];
      const c = {
        query: jest.fn(async (sql: string, params: string[]) => {
          if (sql.startsWith('SELECT')) return { rows };
          updates.push([params[1], sql.includes("= ''") ? '' : params[2]]);
          return { rows: [] };
        }),
      } as unknown as PoolClient;
      return { c, updates };
    };

    it('swaps a still-linked extra into the primary slot when the primary is unlinked', async () => {
      const { c, updates } = fake([
        { id: 'aaaaaaaa-1', account_key: '', status: 'disconnected' },
        { id: 'bbbbbbbb-2', account_key: 'n1', status: 'connected' },
      ]);
      expect(await promoteWhatsAppPrimary(c, 'o')).toBe(true);
      expect(updates.at(-2)).toEqual(['bbbbbbbb-2', '']);
      expect(updates.at(-1)).toEqual(['aaaaaaaa-1', 'n1']);
    });

    it('does nothing while the primary is linked or no other number is linked', async () => {
      expect(await promoteWhatsAppPrimary(fake([{ id: 'a', account_key: '', status: 'connected' }, { id: 'b', account_key: 'n1', status: 'connected' }]).c, 'o')).toBe(false);
      expect(await promoteWhatsAppPrimary(fake([{ id: 'a', account_key: '', status: 'disconnected' }, { id: 'b', account_key: 'n1', status: 'disconnected' }]).c, 'o')).toBe(false);
    });
  });
});
