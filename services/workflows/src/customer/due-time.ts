export type DueBasis = 'explicit' | 'relative' | 'default';
export type Due = { at: Date; basis: DueBasis };
export function inferDueTime(text: string, now = new Date(), defaultHours = 24): Due {
  const iso = String(text || '').match(/\b(20\d{2}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?)?)/);
  if (iso) {
    const parsed = new Date(iso[1].replace(' ', 'T'));
    if (!Number.isNaN(parsed.getTime())) return { at: parsed, basis: 'explicit' };
  }
  if (/\btomorrow\b/i.test(text)) {
    const at = new Date(now);
    at.setUTCDate(at.getUTCDate() + 1);
    at.setUTCHours(16, 0, 0, 0);
    return { at, basis: 'relative' };
  }
  return { at: new Date(now.getTime() + (defaultHours > 0 ? defaultHours : 24) * 3600_000), basis: 'default' };
}
