/** Every WhatsApp transport the platform can use. Add a new id here when you add a provider. */
export type WhatsAppProviderId = 'meta-cloud' | 'evolution';

/** The `channels.meta` JSON for the org's WhatsApp channel. */
export type ChannelMeta = Record<string, unknown>;

export type SendInput = { to: string; text: string };

export type SendResult = {
  /** false when nothing left the building (provider not connected / not configured). */
  attempted: boolean;
  ok: boolean;
  status: number;
  /** Provider message id, used to match delivery receipts (wamid or Evolution key.id). */
  messageId: string | null;
  message: string;
  body: string;
  /** Set when the send failed for a known, actionable reason. */
  code?: 'outside_window';
};

/**
 * One WhatsApp transport. To swap or add one: implement this in
 * `providers/<name>.ts`, add it to `PROVIDERS` in `registry.ts`. Nothing else
 * in the app names a concrete provider when it sends.
 */
export interface WhatsAppProvider {
  readonly id: WhatsAppProviderId;
  readonly label: string;
  /** True when `meta` (plus server env) holds everything needed to send. */
  canSend(meta: ChannelMeta): boolean;
  send(meta: ChannelMeta, input: SendInput): Promise<SendResult>;
  /** Pull an inbound file by provider media id. Providers that inline the file omit this. */
  fetchMedia?(meta: ChannelMeta, media: InboundMedia): Promise<MediaFile | null>;
}

export type InboundMedia = {
  type: string;
  id: string | null;
  mimeType: string | null;
  filename: string | null;
  caption: string | null;
  /** Push providers that inline the file (Evolution). Never stored, only handed to media reading. */
  base64?: string | null;
};

export type MediaFile = { data: Buffer; mimeType: string };

/** Provider-neutral inbound event (push providers normalise their webhook into these). */
export type InboundEvent =
  | { kind: 'message'; from: string; messageId: string; text: string; media: InboundMedia | null; pushName: string | null }
  | { kind: 'status'; messageId: string; status: 'sent' | 'delivered' | 'read' | 'failed' }
  /** `loggedOut` = the phone unlinked the session (needs a new QR), not a transient reconnect. */
  | { kind: 'connection'; state: 'open' | 'connecting' | 'close'; loggedOut: boolean };

export type ParsedWebhook = { instance: string | null; events: InboundEvent[] };
