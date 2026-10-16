import { describeShadowAction } from '../trust-shadow';

describe('describeShadowAction', () => {
  it('uses the saved sentence when there is one', () => {
    expect(describeShadowAction('Send email "Your viewing" to priya@example.com', 'gmail.send_email')).toBe('Send email "Your viewing" to priya@example.com');
  });

  it('turns an action id into words when no sentence was saved, without showing tool ids as code', () => {
    expect(describeShadowAction(null, 'gmail.send_email')).toBe('Gmail: send email');
    expect(describeShadowAction('', 'whatsapp.send-message')).toBe('Whatsapp: send message');
    expect(describeShadowAction('   ', 'razorpay.create_payment_link')).toBe('Razorpay: create payment link');
  });

  it('copes with ids that have no dot, and with nothing at all', () => {
    expect(describeShadowAction(null, 'send_email')).toBe('Send email');
    expect(describeShadowAction(null, '')).toBe('An action it would have taken');
    expect(describeShadowAction(null, null)).toBe('An action it would have taken');
  });

  it('keeps a long sentence to a length that fits on a card', () => {
    const out = describeShadowAction('x'.repeat(1000), 'a.b');
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith('…')).toBe(true);
  });
});
