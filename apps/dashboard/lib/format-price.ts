/** A listing price as a person reads it: ₹85,00,000, not 8500000. Words such as "On request" are kept as written. */
export function formatPrice(value: unknown, currency: string = 'INR'): string {
  if (value === null || value === undefined) return '—';
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '') return '—';
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n)) return String(raw);
  const code = String(currency || 'INR').trim().toUpperCase();
  const locale = code === 'INR' ? 'en-IN' : 'en-US';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code, maximumFractionDigits: 0 }).format(n);
  } catch {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
  }
}
