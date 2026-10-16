export type ConnectorType =
  | 'whatsapp'
  | 'gmail'
  | 'google-calendar'
  | 'google-drive'
  | 'google-docs'
  | 'google-sheets'
  | 'google-slides'
  | 'google-forms'
  | 'google-contacts'
  | 'google-tasks'
  | 'google-ads'
  | 'google-analytics'
  | 'google-search-console'
  | 'google-business-profile'
  | 'google-chat'
  | 'google-meet'
  | 'google-cloud'
  | 'hubspot'
  | 'razorpay'
  | 'meta-ads'
  | 'stripe'
  | 'notion'
  | 'slack'
  | 'shopify'
  | 'zendesk'
  | 'intercom'
  | 'github';

/** Dashboard path for re-authorizing OAuth when credentials are missing or expired. */
export const CONNECTORS_RECONNECT_URL = '/connectors';

export interface ConnectorStatus {
  connectionId: string;
  provider: ConnectorType;
  orgId: string;
  connected: boolean;
  lastSyncedAt?: string;
  error?: string;
  /** Present when connected is false — never fabricate a success without live credentials. */
  reconnectUrl?: string;
}

/** Honest not-connected / expired-credentials payload for API and tool callers. */
export interface NotConnectedResult {
  connected: false;
  reconnectUrl: typeof CONNECTORS_RECONNECT_URL;
  /** Alias kept for older UI that still reads setupUrl. */
  setupUrl: typeof CONNECTORS_RECONNECT_URL;
  reason: 'not_connected' | 'expired' | 'revoked' | 'nango_unconfigured';
  message: string;
  provider?: string;
}

export function notConnectedResult(
  reason: NotConnectedResult['reason'],
  message: string,
  provider?: string
): NotConnectedResult {
  return {
    connected: false,
    reconnectUrl: CONNECTORS_RECONNECT_URL,
    setupUrl: CONNECTORS_RECONNECT_URL,
    reason,
    message,
    provider,
  };
}

export interface SendMessagePayload {
  recipient: string;
  text: string;
  templateName?: string;
  templateArgs?: Record<string, string>;
}

export interface CreateCalendarEventPayload {
  title: string;
  description?: string;
  startTime: string; // ISO string
  endTime: string;   // ISO string
  attendeeEmails: string[];
}

export interface CreateHubspotContactPayload {
  email: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  company?: string;
}

export interface CreateRazorpayInvoicePayload {
  customerEmail: string;
  amountInPaisa: number;
  description: string;
}

export interface WhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
}

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export interface ConnectionPingResult {
  connected: boolean;
  provider: string;
  ok: boolean;
  status: number;
  message: string;
  data?: unknown;
  reconnectUrl?: string;
}
