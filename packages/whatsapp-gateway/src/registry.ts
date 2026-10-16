import { evolution } from './providers/evolution/index.js';
import { metaCloud } from './providers/meta-cloud.js';
import type {
  ChannelMeta,
  InboundMedia,
  MediaFile,
  SendInput,
  SendResult,
  WhatsAppProvider,
  WhatsAppProviderId,
} from './types.js';

/** The one place providers are listed. Add / remove / swap a provider here. */
const PROVIDERS: Record<WhatsAppProviderId, WhatsAppProvider> = {
  'meta-cloud': metaCloud,
  evolution,
};

export const WHATSAPP_PROVIDERS = Object.values(PROVIDERS).map(({ id, label }) => ({ id, label }));

/** Channels saved before providers existed have no `provider` key: they are Meta. */
export function providerIdOf(meta: ChannelMeta | null | undefined): WhatsAppProviderId {
  const id = meta?.provider;
  return typeof id === 'string' && id in PROVIDERS ? (id as WhatsAppProviderId) : 'meta-cloud';
}

export function getWhatsAppProvider(meta: ChannelMeta | null | undefined): WhatsAppProvider {
  return PROVIDERS[providerIdOf(meta)];
}

export function sendWhatsApp(meta: ChannelMeta | null | undefined, input: SendInput): Promise<SendResult> {
  return getWhatsAppProvider(meta).send(meta ?? {}, input);
}

/** Bytes of an inbound file: inline base64 when the provider sent it, else the provider's fetch. */
export async function fetchWhatsAppMedia(
  meta: ChannelMeta | null | undefined,
  media: InboundMedia
): Promise<MediaFile | null> {
  if (media.base64) {
    return { data: Buffer.from(media.base64, 'base64'), mimeType: media.mimeType || 'application/octet-stream' };
  }
  const provider = getWhatsAppProvider(meta);
  return provider.fetchMedia ? provider.fetchMedia(meta ?? {}, media) : null;
}
