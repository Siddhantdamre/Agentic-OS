/**
 * @jest-environment node
 *
 * Outbound sends record their outcome on the message row: the WhatsApp wamid
 * so receipts match (CH-B01), and `failed` when the send did not go out (CH-B12).
 */
const query = jest.fn();
const release = jest.fn();
jest.mock('@/lib/db', () => ({
  pool: { query: jest.fn() },
  getOrgScopedClient: jest.fn(async () => ({ client: { query, release }, orgId: 'org-1' })),
}));
jest.mock('@/lib/nango-server', () => ({ getNangoConnection: jest.fn() }));

import { whatsappMessageIdFromResponse } from '@/lib/channel-outbound';
import { recordOutboundDelivery } from '@/lib/failed-webhooks';

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rowCount: 1, rows: [{ id: 'm-1' }] });
  release.mockReset();
});

describe('whatsappMessageIdFromResponse', () => {
  it('reads messages[0].id from the Graph response', () => {
    const body = JSON.stringify({
      messaging_product: 'whatsapp',
      contacts: [{ input: '15551234567', wa_id: '15551234567' }],
      messages: [{ id: 'wamid.HBgLMTU1NTEyMzQ1NjcVAgARGBI' }],
    });
    expect(whatsappMessageIdFromResponse(body)).toBe('wamid.HBgLMTU1NTEyMzQ1NjcVAgARGBI');
  });

  it('returns null for errors and junk', () => {
    expect(whatsappMessageIdFromResponse('{"error":{"code":131047}}')).toBeNull();
    expect(whatsappMessageIdFromResponse('not json')).toBeNull();
  });
});

describe('recordOutboundDelivery', () => {
  const sent = {
    attempted: true,
    sent: true,
    statusCode: 200,
    message: 'ok',
    body: '',
    providerMessageId: 'wamid.X',
  };

  it('stores the wamid and sent status on a known row', async () => {
    await expect(recordOutboundDelivery({ orgId: 'org-1', messageId: 'm-1', result: sent })).resolves.toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE org_id = \$3 AND id = \$4/);
    expect(params).toEqual(['sent', 'wamid.X', 'org-1', 'm-1']);
    expect(release).toHaveBeenCalled();
  });

  it('marks a failed send as failed without a provider id', async () => {
    await recordOutboundDelivery({
      orgId: 'org-1',
      messageId: 'm-2',
      result: { attempted: true, sent: false, statusCode: 502, message: 'bad', body: '' },
    });
    expect(query.mock.calls[0][1]).toEqual(['failed', null, 'org-1', 'm-2']);
  });

  it('falls back to the newest unmatched row of the role', async () => {
    await recordOutboundDelivery({ orgId: 'org-1', conversationId: 'c-1', role: 'assistant', result: sent });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/chatwoot_msg_id IS NULL/);
    expect(params).toEqual(['sent', 'wamid.X', 'org-1', 'c-1', 'assistant']);
  });

  it('does nothing when no external send was attempted', async () => {
    await expect(
      recordOutboundDelivery({
        orgId: 'org-1',
        messageId: 'm-1',
        result: { attempted: false, sent: false, statusCode: 0, message: 'dashboard', body: '' },
      })
    ).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
