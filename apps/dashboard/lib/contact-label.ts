/**
 * The name shown for a conversation in the Inbox. A name the customer gave wins; a phone number or email
 * address is kept (people recognise those); an internal id such as `ask-ai:<uuid>` becomes a plain label.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function plain(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return '';
  if (/^ask-ai[:_]/i.test(v)) return 'Ask AI chat';
  if (/^(widget|visitor|web|anon)[:_-]/i.test(v)) return 'Website visitor';
  if (UUID.test(v) && !/\s/.test(v)) return 'Unnamed contact';
  if (/^[0-9a-f]{24,}$/i.test(v)) return 'Unnamed contact';
  return v;
}

export function contactLabel({ senderName, contactId }: { senderName?: unknown; contactId?: unknown }): string {
  const name = plain(senderName);
  if (name && name !== 'Unnamed contact') return name;
  return plain(contactId) || 'Unnamed contact';
}

/** The phone number or email address to show beside a name; nothing when the id is only an internal code. */
export function contactDetail(contactId: unknown): string {
  const v = typeof contactId === 'string' ? contactId.trim() : '';
  if (!v) return '';
  return plain(v) === v && !/^Unnamed contact/i.test(v) ? v : '';
}
