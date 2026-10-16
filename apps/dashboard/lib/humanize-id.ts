const CAPS = new Set(['faq', 'crm', 'sla', 'sms', 'api', 'pdf', 'url', 'id', 'kyc', 'gst', 'roi', 'ctr', 'ai', 'seo', 'otp', 'qr']);

/** A stored code as a person reads it: `answer_faq` -> "Answer FAQ". Text that is already ordinary is left as written. */
export function humanizeId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  if (!id) return '';
  if (/\s/.test(id) || !/[_.-]/.test(id)) return id; // already words, or a single word
  const parts = id.replace(/^mcp\.[^.]+\./i, '').split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return id;
  const words = parts.map((w) => (CAPS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
  const first = words[0];
  words[0] = CAPS.has(first.toLowerCase()) ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(' ');
}
