# @darex/whatsapp-gateway

Swappable WhatsApp transports. The app never names a concrete provider when it
sends; it calls `sendWhatsApp(channelMeta, { to, text })` and the registry picks
the provider from `channels.meta.provider` (missing = `meta-cloud`).

| Provider id | Folder | How it connects | Inbound webhook |
|---|---|---|---|
| `meta-cloud` | `src/providers/meta-cloud.ts` | Official WhatsApp Cloud API, customer pastes a Meta token | `/api/webhooks/whatsapp` |
| `evolution` | `src/providers/evolution/` | Scan a QR (WhatsApp Web) through a self-hosted Evolution API | `/api/webhooks/whatsapp-evolution` |

Also here: `fetchWhatsAppMedia` (inbound voice notes and images: inline for Evolution, by media id
for Meta), 24-hour-window handling with an optional fallback template in the Meta provider, and
`completeEmbeddedSignup` (server half of Meta Embedded Signup).

## Replace or add a provider

1. Add the id to `WhatsAppProviderId` in `src/types.ts`.
2. Create `src/providers/<name>.ts` (or a folder) exporting a `WhatsAppProvider`
   (`canSend`, `send`). Push providers also export a webhook parser that returns
   `InboundEvent[]`.
3. Add it to `PROVIDERS` in `src/registry.ts`.
4. Add a dashboard webhook route that parses with your parser and calls the
   shared `ingestWhatsAppInbound` (`apps/dashboard/lib/whatsapp-inbound.ts`).
5. Add a connect option in the WhatsApp modal on `/connectors`.

To drop a provider: delete its folder and registry line. Channels saved with
that id fall back to `meta-cloud`.

## Token storage

`src/secrets.ts` seals channel tokens (AES-256-GCM, `CHANNEL_SECRETS_KEY`). Providers open them at use;
plaintext legacy values still pass through. Seal old rows with `infra/scripts/seal-whatsapp-tokens.js`.

## Env (Evolution)

`EVOLUTION_API_URL`, `EVOLUTION_API_KEY` (server-to-server), and
`EVOLUTION_WEBHOOK_SECRET` (checked by the dashboard on inbound).

Evolution API is Apache-2.0 with a condition: systems using it must show a
notice that it is in use. The connect modal carries it.

Tests: `pnpm --filter @darex/whatsapp-gateway test`
