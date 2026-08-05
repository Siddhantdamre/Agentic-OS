export type ConnectorType =
  | 'whatsapp'
  | 'gmail'
  | 'google-calendar'
  | 'hubspot'
  | 'razorpay'
  | 'meta-ads'
  | 'google-ads';

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
