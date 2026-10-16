import { contactLabel, contactDetail } from '../contact-label';

describe('contactLabel', () => {
  it('prefers the name the customer gave', () => {
    expect(contactLabel({ senderName: 'Priya Nair', contactId: '+919800000000' })).toBe('Priya Nair');
  });

  it('shows an Ask AI chat as such, not as a code with a long id', () => {
    expect(contactLabel({ contactId: 'ask-ai:97fdee74-209e-4942-b3e3-edb8399840c7' })).toBe('Ask AI chat');
  });

  it('shows a website visitor id as a visitor', () => {
    expect(contactLabel({ contactId: 'widget:6f1c2a9e0b7d4c8e9a3b5d7f1e2c4a6b' })).toBe('Website visitor');
    expect(contactLabel({ contactId: 'visitor_6f1c2a9e0b7d4c8e9a3b5d7f1e2c4a6b' })).toBe('Website visitor');
  });

  it('keeps a phone number or an email address, which people recognise', () => {
    expect(contactLabel({ contactId: '+919800000000' })).toBe('+919800000000');
    expect(contactLabel({ contactId: 'anita@example.test' })).toBe('anita@example.test');
  });

  it('does not show a bare uuid', () => {
    expect(contactLabel({ contactId: '97fdee74-209e-4942-b3e3-edb8399840c7' })).toBe('Unnamed contact');
  });

  it('ignores a blank or id-shaped sender name', () => {
    expect(contactLabel({ senderName: '  ', contactId: 'anita@example.test' })).toBe('anita@example.test');
    expect(contactLabel({ senderName: 'ask-ai:97fdee74-209e-4942-b3e3-edb8399840c7', contactId: 'x' })).toBe('Ask AI chat');
  });

  it('always returns something to show', () => {
    expect(contactLabel({})).toBe('Unnamed contact');
  });
});

describe('contactDetail', () => {
  it('gives the number or address to show beside a name, and nothing for an internal code', () => {
    expect(contactDetail('+919800000000')).toBe('+919800000000');
    expect(contactDetail('anita@example.test')).toBe('anita@example.test');
    expect(contactDetail('ask-ai:97fdee74-209e-4942-b3e3-edb8399840c7')).toBe('');
    expect(contactDetail('97fdee74-209e-4942-b3e3-edb8399840c7')).toBe('');
    expect(contactDetail(undefined)).toBe('');
  });
});
