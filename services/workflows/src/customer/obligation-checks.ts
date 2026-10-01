export type MessageSender = 'customer' | 'employee' | 'system';
export function quoteIsGrounded(quote: string, sourceText: string): boolean {
  return Boolean(String(quote || '').trim()) && String(sourceText || '').includes(String(quote).trim());
}
export function obligorSenderMismatch(obligor: 'us' | 'them', sender: MessageSender): boolean {
  return obligor === 'us' && sender === 'customer';
}
