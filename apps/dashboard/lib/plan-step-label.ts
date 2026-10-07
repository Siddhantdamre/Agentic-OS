import { channelName } from '@/lib/ask-ai-welcome';

const words = (s: string) => s.split(/[._\s-]+/).filter(Boolean);

/** "google-sheets" + "sheets_read" -> "Google Sheets · Read". A plan step shows this instead of `mcp.google-sheets.sheets_read`. */
export function planStepLabel(tool: string, action: string): string {
  let app = String(tool || '').trim();
  let act = String(action || '').trim();
  if (/^mcp\./i.test(app) || app.split('.').length >= 2) {
    const parts = app.replace(/^mcp\./i, '').split('.');
    app = parts[0] || '';
    if (!act) act = parts.slice(1).join('_');
  }
  const appName = channelName(app);
  const appWords = new Set(words(app.toLowerCase()).concat(words(appName.toLowerCase())));
  const verb = words(act.toLowerCase()).filter((w) => !appWords.has(w)).join(' ');
  const sentence = verb ? verb.charAt(0).toUpperCase() + verb.slice(1) : '';
  return sentence ? `${appName} · ${sentence}` : appName;
}
