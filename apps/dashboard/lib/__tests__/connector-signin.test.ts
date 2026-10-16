import { canStartOAuthInline, connectorSignInPath, providerIdForTool, providerIdFromConnectHref } from '@/lib/integrations-catalog';

describe('connector sign-in path', () => {
  it('maps a tool name onto the account it shares', () => {
    expect(providerIdForTool('gmail_send')).toBe('gmail');
    expect(providerIdForTool('mcp.darex.sheets_read')).toBe('google-sheets');
    expect(providerIdForTool('calendar_list_events')).toBe('google-calendar');
    expect(providerIdForTool('search_console_sites')).toBe('google-search-console');
    expect(providerIdForTool('quickbooks_list_invoices')).toBe('quickbooks');
    expect(connectorSignInPath('drive_list')).toBe('/connectors?connect=google-drive');
    expect(connectorSignInPath('quickbooks')).toBe('/connectors?connect=quickbooks');
  });

  it('keeps unknown tools on the connectors page', () => {
    expect(providerIdForTool('linkedin')).toBeNull();
    expect(providerIdForTool('zoho-crm')).toBeNull();
    expect(connectorSignInPath('apollo')).toBe('/connectors');
  });

  it('reads the account from a connect link and knows which ones open inline', () => {
    expect(providerIdFromConnectHref('/connectors?connect=gmail')).toBe('gmail');
    expect(providerIdFromConnectHref('/connectors?connect=gmail-send')).toBe('gmail');
    expect(providerIdFromConnectHref('/connectors')).toBeNull();
    expect(providerIdForTool('outlook_send')).toBe('microsoft-outlook');
    expect(providerIdForTool('outlook_calendar_list_events')).toBe('microsoft-calendar');
    expect(canStartOAuthInline('gmail')).toBe(true);
    expect(canStartOAuthInline('microsoft-outlook')).toBe(true);
    expect(canStartOAuthInline('shopify')).toBe(false);
    expect(canStartOAuthInline('whatsapp')).toBe(false);
    expect(canStartOAuthInline('linkedin')).toBe(false);
  });
});
