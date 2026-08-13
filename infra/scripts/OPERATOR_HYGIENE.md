# Operator hygiene runbook

Unblocks live tools. These are ops steps, not missing product features.
Code already returns `status: 'error'`, `connected: false`, and a `/connectors`
setup URL when OAuth or tokens are missing. **Never fabricate a success.**

Do **not** commit secrets. `.env*` is gitignored. Paste values only into local
env files and third-party consoles. `.env.example` is names/placeholders only.

After these steps, keep running the existing probes unchanged:

```bash
node infra/scripts/check-phase0.js
node infra/scripts/check-phase2.js
node infra/scripts/check-phase3.js
```

Do not skip or weaken a failing check. Offline evals (not Ask AI): `bash infra/scripts/run-evals.sh`.

---

## 1. Apply migrations 009–011

On an older local/staging database the working tree expects three extra
migrations:

| File | What it adds |
|------|----------------|
| `009_auth_tenancy.sql` | Unique emails, invite/reset, `darex_app` auth helpers |
| `010_webhook_inbox.sql` | Per-org webhook meta, inbound idempotency |
| `011_employees_app_role.sql` | `graph_id` default + `GRANT` so `darex_app` can connect |

Migrations run as superuser `darex` via `infra/db/migrate.js`. Runtime apps
use `DB_USER=darex_app` (least privilege). Do not point `pnpm db:migrate` at
the app role.

```bash
pnpm db:migrate
```

Confirm `_migrations` contains `009_auth_tenancy.sql`, `010_webhook_inbox.sql`,
and `011_employees_app_role.sql`. Then re-run `check-phase0.js` (and 2/3 if
the stack is up). Tables must exist; probes must still pass.

---

## 2. Paste real Nango OAuth client IDs

Nango UI: `http://localhost:3003`. Placeholder client IDs cannot finish an
OAuth popup. Until a real ID is pasted, connect stays `notConnected` — that
is correct.

Wave-A providers that typically still need **your** OAuth app credentials in
the Nango UI (not in git):

- HubSpot, Stripe, Notion, Slack, Shopify, Zendesk, Intercom, Meta Ads

Google providers can reuse an existing Google OAuth client already stored on
the `gmail` / `google` / `google-calendar` Nango config. Do not copy those
secrets into the repo. If no Google config exists, configure it in the Nango
UI, then optionally run:

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U darex -d nango < infra/scripts/seed-nango-configs.sql
docker compose -f infra/docker-compose.yml restart nango-server
```

`NANGO_SECRET_KEY` must be Nango’s **dev UUID** (Settings → API keys). A
non-UUID string makes every tool return `notConnected`.

Demo DoD: each provider used in a demo shows a real Nango connection, not
“no client id”.

---

## 3. Re-connect Gmail after `gmail.compose`

Draft/send need `gmail.compose` (and `gmail.modify`). Tokens minted before
that scope was added will 403.

1. Apply the seed SQL in §2 so the `gmail` Nango config includes
   `gmail.send`, `gmail.readonly`, `gmail.compose`, `gmail.modify`.
2. Restart `nango-server`.
3. In the dashboard `/connectors`, disconnect Gmail, then Connect OAuth again
   in the browser. Consent the new scopes.
4. Retry draft/send. Success is a real Gmail API result. Failure is an honest
   token/OAuth error — never a fake `wamid` or invented send.

---

## 4. Rotate the Meta WhatsApp token

`META_ACCESS_TOKEN` expired **2026-06-12** (Graph 401). Outbound send cannot
succeed until a new token exists.

1. In Meta Developer Console, issue a new access token for the WhatsApp
   Business app. Note `WHATSAPP_PHONE_NUMBER_ID` and the webhook verify token.
2. Put `META_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `VERIFY_TOKEN` in
   gitignored env (`infra/.env` and `apps/dashboard/.env.local` as you run).
   Align `CHATWOOT_WEBHOOK_SECRET` on dashboard and the inbox container.
3. Set the Meta webhook URL to the dashboard WhatsApp route
   (`/api/webhooks/whatsapp`) and the verify token to `VERIFY_TOKEN`.
4. Restart dashboard / worker so they pick up env.

DoD: inbound WhatsApp persists (webhook returns 200, then Temporal). Outbound
`whatsapp_send` reaches Graph. Missing/expired token → Graph error, never a
fabricated message id.

Optional live probe (needs a valid token; skip rather than fake):

```bash
node infra/scripts/e2e-live-llm.js
```

---

## 5. Set `JINA_API_KEY`

Web search/extract use Jina (`s.jina.ai` / `r.jina.ai`). Set `JINA_API_KEY`
in gitignored env. No key → honest missing/error, not a silent empty page of
invented results.

---

## 6. Env names only (no values)

Copy names from `.env.example`. Typical files: `infra/.env`,
`apps/dashboard/.env.local`. Compose `environment` wins over `env_file`.

| Name | Used for |
|------|----------|
| `DB_USER` / `DB_PASSWORD` | Runtime default `darex_app`; migrate as `darex` |
| `NANGO_SECRET_KEY` | Must be Nango UUID |
| `META_ACCESS_TOKEN` | WhatsApp Graph outbound |
| `WHATSAPP_PHONE_NUMBER_ID` | Graph send path |
| `VERIFY_TOKEN` | Meta webhook challenge |
| `JINA_API_KEY` | `web_search` / `web_extract` |
| `CHATWOOT_WEBHOOK_SECRET` | Same value on dashboard + inbox `:3004` |

Never commit `.env`, Nango client secrets, Meta tokens, or Jina keys.
