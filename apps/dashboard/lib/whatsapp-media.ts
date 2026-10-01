import { fetchWhatsAppMedia, type InboundMedia } from '@darex/whatsapp-gateway';
import { getOrgScopedClient } from '@/lib/db';
import { mediaCompletion } from '@/lib/litellm-client';

/**
 * Read an inbound WhatsApp voice note or image so the reply (agent or simple
 * AI) can use what the customer actually sent. Both providers: Evolution
 * inlines the file, Meta is fetched by media id. Returns null when it cannot
 * be read (unsupported type, too big, fetch or model failure): the caller
 * keeps the metadata-only text and nothing is invented.
 */

const MAX_BYTES = 10 * 1024 * 1024;

const AUDIO_PROMPT =
  'Transcribe this voice note exactly, in the language spoken. Output only the transcript. If it is silent or unintelligible, output exactly: [unintelligible]';
const IMAGE_PROMPT =
  'Describe this image in one or two sentences for a customer-support agent. Copy any visible text exactly. Output only the description.';

export async function readWhatsAppMedia(input: {
  orgId: string;
  conversationId: string;
  /** Provider message id (saved as messages.chatwoot_msg_id). */
  providerMessageId?: string;
  media: InboundMedia;
  /** Provider routing + Meta credentials, same shape the outbound send uses. */
  channelMeta: Record<string, unknown>;
}): Promise<string | null> {
  const { media } = input;
  if (media.type !== 'audio' && media.type !== 'image') return null;
  try {
    const file = await fetchWhatsAppMedia(input.channelMeta, media);
    if (!file || file.data.length === 0 || file.data.length > MAX_BYTES) return null;

    const kind = media.type;
    const said = await mediaCompletion(
      kind === 'audio' ? AUDIO_PROMPT : IMAGE_PROMPT,
      { kind, mimeType: file.mimeType, base64: file.data.toString('base64') },
      { maxTokens: kind === 'audio' ? 600 : 200, orgId: input.orgId }
    );
    if (!said) return null;

    const caption = media.caption?.trim();
    const text =
      kind === 'audio'
        ? `[voice note] ${said}`
        : `[image] ${said}${caption ? ` Caption: ${caption}` : ''}`;
    await saveReading(input, text, said);
    return text;
  } catch (err: unknown) {
    console.warn('[whatsapp-media] could not read %s:', media.type, err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function saveReading(
  input: { orgId: string; conversationId: string; providerMessageId?: string },
  content: string,
  reading: string
): Promise<void> {
  if (!input.providerMessageId) return;
  const { client } = await getOrgScopedClient(input.orgId);
  try {
    await client.query(
      `UPDATE messages
          SET content = $1,
              tool_calls = jsonb_set(
                jsonb_set(COALESCE(tool_calls, '{}'::jsonb), '{media,transcript}', to_jsonb($2::text), true),
                '{media,note}', to_jsonb('Read by the model from the file'::text), true)
        WHERE org_id = $3 AND conversation_id = $4 AND chatwoot_msg_id = $5 AND role = 'user'`,
      [content, reading, input.orgId, input.conversationId, input.providerMessageId]
    );
  } finally {
    client.release();
  }
}
