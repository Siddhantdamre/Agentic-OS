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

export interface ConnectorStatus {
  connectionId: string;
  provider: ConnectorType;
  orgId: string;
  connected: boolean;
  lastSyncedAt?: string;
  error?: string;
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
}
