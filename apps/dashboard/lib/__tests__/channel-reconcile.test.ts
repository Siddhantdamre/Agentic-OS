import { oauthChannelsToDemote } from '../channel-reconcile';

describe('oauthChannelsToDemote', () => {
  const defs = [
    { id: 'gmail', authMode: 'oauth' },
    { id: 'slack', authMode: 'oauth' },
    { id: 'whatsapp', authMode: 'byok' },
    { id: 'razorpay', authMode: 'api_key' },
  ];

  it('demotes oauth channels marked connected when absent from a successful Nango list', () => {
    const db = new Map([
      ['gmail', 'connected'],
      ['slack', 'connected'],
      ['whatsapp', 'connected'],
    ]);
    const live = new Set(['gmail']);
    expect(oauthChannelsToDemote(defs, db, live, true)).toEqual(['slack']);
  });

  it('does nothing when the Nango list was not trustworthy', () => {
    const db = new Map([['gmail', 'connected']]);
    expect(oauthChannelsToDemote(defs, db, new Set(), false)).toEqual([]);
  });

  it('ignores byok and api_key providers', () => {
    const db = new Map([
      ['whatsapp', 'connected'],
      ['razorpay', 'active'],
    ]);
    expect(oauthChannelsToDemote(defs, db, new Set(), true)).toEqual([]);
  });
});
