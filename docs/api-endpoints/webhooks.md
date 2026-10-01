# Inbound webhooks

Every handler in this area, taken from the Next.js route files. Field lists are the names the handler reads or returns. They are the contract a new frontend should call. The route file is the source of truth if a field looks incomplete.

**Count.** 16 handlers across 13 paths.

## Paths

- `POST` `/api/webhooks/billing`
- `POST` `/api/webhooks/chatwoot`
- `POST` `/api/webhooks/gmail`
- `POST` `/api/webhooks/google-calendar`
- `POST` `/api/webhooks/google-calendar/google-calendar`
- `GET, POST` `/api/webhooks/instagram`
- `POST` `/api/webhooks/nango`
- `POST` `/api/webhooks/outbound`
- `GET, POST` `/api/webhooks/owner-whatsapp`
- `POST` `/api/webhooks/rent-payment`
- `POST` `/api/webhooks/slack/interactions`
- `POST` `/api/webhooks/sms`
- `GET, POST` `/api/webhooks/whatsapp`

## Endpoints

### POST `/api/webhooks/billing`

Darex SaaS billing (Stripe / Razorpay). Signature required. Never awaits an LLM. Unsigned → 401. DB apply only, then 200.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

- **401** keys: `error`
- **400** keys: `error`
- **200** keys: `received`, `duplicate`
- **200** keys: `received`, `status`
- **500** keys: `error`, `status`

**Error strings in this handler.**
- Unsigned billing webhook rejected
- Invalid JSON
- Missing event id
- webhook apply failed

**Source.** `apps/dashboard/app/api/webhooks/billing/route.ts`

### POST `/api/webhooks/chatwoot`

POST /api/webhooks/chatwoot.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Headers the handler reads.**
- `x-chatwoot-signature`

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

- **200** keys: `error`
- **400** keys: `error`
- **200** keys: `success`, `ignored`, `event`
- **500** keys: `success`, `error`
- **200** keys: `success`, `latencyMs`, `org_id`, `conversation_id`, `message_id`, `event`, `channel_type`

**Error strings in this handler.**
- Invalid JSON payload
- contact_id is required in webhook payload for multi-tenant routing
- Cannot resolve organization. Map the Chatwoot inbox to an org, or include Authorization header.

**Source.** `apps/dashboard/app/api/webhooks/chatwoot/route.ts`

### POST `/api/webhooks/gmail`

Gmail Pub/Sub push → persist work item + parse portal email already received (never scrape). H1/Gmail reconnect: infra/scripts/OPERATOR_HYGIENE.md §3.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/webhooks/gmail/route.ts`

### POST `/api/webhooks/google-calendar`

Google Calendar push notifications. Fail closed unless X-Goog-Channel-Token matches the stored channel token hash. Never invents calendar events or showings — only updates rows that already have a matching calendar_event_id. Same handler behavior as [POST `/api/webhooks/google-calendar/google-calendar`](#post-apiwebhooksgoogle-calendargoogle-calendar) (byte-identical nested duplicate).

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Headers the handler reads.**
- `x-goog-channel-id`
- `x-goog-channel-token`
- `x-goog-resource-state`
- `x-goog-resource-id`

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

- **401** keys: `error`
- **503** keys: `ok`, `configured`, `message`
- **200** keys: `ok`, `configured`, `synced`, `message`
- **200** keys: `ok`, `configured`, `synced`, `status`, `message`
- **200** keys: `ok`, `configured`, `handshake`
- **200** keys: `ok`, `configured`, `synced`, `connected`, `reconnectUrl`, `message`
- **200** keys: `ok`, `configured`, `synced`, `needsFullSync`, `message`
- **200** keys: `ok`, `configured`, `synced`, `invented`

**Error strings in this handler.**
- Missing channel id or token — fail closed
- gcal_calendar_watches migration not applied — no fake sync
- Unknown channel — fail closed
- Invalid channel token — fail closed
- Watch is not_configured — acknowledged without sync (no fabricated events)
- Google sync token expired (410). Cleared token; will not invent events.

**Source.** `apps/dashboard/app/api/webhooks/google-calendar/route.ts`

### POST `/api/webhooks/google-calendar/google-calendar`

Same handler behavior as [POST `/api/webhooks/google-calendar`](#post-apiwebhooksgoogle-calendar). Nested path is reachable; file is byte-identical to the parent route.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Headers the handler reads.**
- `x-goog-channel-id`
- `x-goog-channel-token`
- `x-goog-resource-state`
- `x-goog-resource-id`

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

- **401** keys: `error`
- **503** keys: `ok`, `configured`, `message`
- **200** keys: `ok`, `configured`, `synced`, `message`
- **200** keys: `ok`, `configured`, `synced`, `status`, `message`
- **200** keys: `ok`, `configured`, `handshake`
- **200** keys: `ok`, `configured`, `synced`, `connected`, `reconnectUrl`, `message`
- **200** keys: `ok`, `configured`, `synced`, `needsFullSync`, `message`
- **200** keys: `ok`, `configured`, `synced`, `invented`

**Error strings in this handler.**
- Missing channel id or token — fail closed
- gcal_calendar_watches migration not applied — no fake sync
- Unknown channel — fail closed
- Invalid channel token — fail closed
- Watch is not_configured — acknowledged without sync (no fabricated events)
- Google sync token expired (410). Cleared token; will not invent events.

**Source.** `apps/dashboard/app/api/webhooks/google-calendar/google-calendar/route.ts`

### GET `/api/webhooks/instagram`

Meta webhook verification. Same app secret as WhatsApp (X-Hub-Signature-256).

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Query.**
- `hub.mode`
- `hub.verify_token`
- `hub.challenge`

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/webhooks/instagram/route.ts`

### POST `/api/webhooks/instagram`

Persist → 200 → WorkItemWorkflow. Org from Instagram channel config.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Headers the handler reads.**
- `x-hub-signature-256`

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/webhooks/instagram/route.ts`

### POST `/api/webhooks/nango`

Verified by X-Nango-Signature (NANGO_WEBHOOK_SECRET). 503 until the secret is set — do not enable webhooks in the Nango UI before then. Connection IDs are `${orgId}_${provider}`, so the org resolves from the event itself (never from body org_id, which is ignored). Side effects are log-only: connection state stays lazily discovered via

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Headers the handler reads.**
- `x-nango-signature`

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

- **200** keys: `error`
- **400** keys: `error`
- **200** keys: `ok`, `logged`

**Error strings in this handler.**
- Invalid JSON body

**Source.** `apps/dashboard/app/api/webhooks/nango/route.ts`

### POST `/api/webhooks/outbound`

Authenticated inbox-gateway send. Tenant is resolved from the conversation row — body org_id is ignored.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Headers the handler reads.**
- `x-chatwoot-signature`

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

- **200** keys: `error`
- **400** keys: `error`
- **404** keys: `error`
- **200** keys: `success`, `attempted`, `sent`, `statusCode`, `message`, `messageId`
- **500** keys: `success`, `error`

**Error strings in this handler.**
- Invalid JSON payload
- conversationId and content are required
- Conversation not found

**Source.** `apps/dashboard/app/api/webhooks/outbound/route.ts`

### GET `/api/webhooks/owner-whatsapp`

Distinct number from customer WABA (H5). Mixing numbers is a security bug. H1 token rotation: infra/scripts/OPERATOR_HYGIENE.md -4.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Query.**
- `hub.mode`
- `hub.verify_token`
- `hub.challenge`

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/webhooks/owner-whatsapp/route.ts`

### POST `/api/webhooks/owner-whatsapp`

Persist + 200 first. Owner approve unblocks the same plan id as PlanCard. Customer inbound on the other number cannot invoke these commands.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Headers the handler reads.**
- `x-hub-signature-256`

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/webhooks/owner-whatsapp/route.ts`

### POST `/api/webhooks/rent-payment`

Tenant rent PSP webhooks (Stripe Checkout / Razorpay Payment Link). Distinct from SaaS billing webhooks. Requires signature. Closes pm_charges only with verified psp_payment_id (close_gate). Returns 200 after persist — never awaits an agent.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Headers the handler reads.**
- `stripe-signature`
- `x-razorpay-signature`

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

- **200** keys: `error`
- **401** keys: `error`
- **400** keys: `error`
- **200** keys: `received`, `ignored`
- **404** keys: `error`
- **500** keys: `error`
- **200** keys: `received`, `closed`

**Error strings in this handler.**
- Unauthorized
- Invalid JSON
- Missing metadata
- Unknown org
- Charge not found
- Apply failed

**Source.** `apps/dashboard/app/api/webhooks/rent-payment/route.ts`

### POST `/api/webhooks/slack/interactions`

POST /api/webhooks/slack/interactions.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Headers the handler reads.**
- `x-slack-request-timestamp`
- `x-slack-signature`

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

- **200** keys: `ok`, `ignored`
- **200** keys: `ok`, `workItemId`
- **200** keys: `ok`, `error`

**Error strings in this handler.**
- persist_failed

**Source.** `apps/dashboard/app/api/webhooks/slack/interactions/route.ts`

### POST `/api/webhooks/sms`

Twilio (or compatible) inbound SMS. Signature required. Persist → 200 → WorkItemWorkflow. Org from SMS/Twilio channel config (To number), never body org_id.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Headers the handler reads.**
- `x-twilio-signature`

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/webhooks/sms/route.ts`

### GET `/api/webhooks/whatsapp`

Meta webhook verification challenge handler. H1 Meta token rotation is ops - see infra/scripts/OPERATOR_HYGIENE.md §4. Never commit META_ACCESS_TOKEN. Revoked Graph ≠ {success:true}.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Query.**
- `hub.mode`
- `hub.verify_token`
- `hub.challenge`

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/webhooks/whatsapp/route.ts`

### POST `/api/webhooks/whatsapp`

Persist inbound message, return 200, then fire-and-forget Temporal.

**Auth.** Public. No session cookie. The handler verifies a provider signature, shared secret, or channel token.

**Headers the handler reads.**
- `x-hub-signature-256`

**JSON body fields the handler reads.**

_Body is read as raw text (webhook payload), not parsed as a typed JSON object by this handler._

**JSON responses.**

_No `NextResponse.json({...})` object. The handler may stream, redirect, or return a raw `Response`._

**Source.** `apps/dashboard/app/api/webhooks/whatsapp/route.ts`
