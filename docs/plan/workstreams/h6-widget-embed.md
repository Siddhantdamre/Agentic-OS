# H6 — Public chat widget embed

**Status (2026-08-14): done in code.** Public embed JS + snippet in Settings.
Gmail Pub/Sub and a distinct owner WhatsApp number are out of scope here.

Linked from [06-channels-and-surfaces.md](./06-channels-and-surfaces.md).

---

## Usage

1. Finish onboarding so a pack is installed (widget is deny-all until then).
2. Dashboard → **Settings → Webhooks & API Keys → Public chat widget** → Generate site key.
3. Optional: save allowed origins (`https://www.example.com`), one per line.
4. Paste the snippet on the customer site:

```html
<script src="https://YOUR_DAREX_HOST/embed/widget.js" data-site-key="dxw_YOUR_SITE_KEY" async></script>
```

`YOUR_DAREX_HOST` is `NEXT_PUBLIC_APP_URL` (no trailing slash). Local default:

```html
<script src="http://localhost:3000/embed/widget.js" data-site-key="YOUR_SITE_KEY" async></script>
```

Optional attributes: `data-title`, `data-primary`, `data-api` (override API origin if the script is copied off-host).

## Inbound path

`POST /api/widget/session` (visitor) → `POST /api/widget/message` (content) → persist conversation + message → **HTTP 200** → `fireInboundAgent` (Temporal WorkItem, not awaited). GET `/api/widget/message?sessionId=` polls assistant rows for the bubble UI.

## Security

- Tenant from hashed site key (`resolve_widget_org_by_token_hash`). Body `org_id` / `orgId` is ignored.
- Missing/invalid key → **401** `{ error, connected: false }` (no org leak).
- Pack not installed / admin tool / origin not allowlisted → **403**.
- Allowlist: `listings.search` only. No `database_query`, Drive, billing, Ask AI.
- CORS: reflects `Origin` when allowlist is empty or `*`; otherwise exact origin match.
- Embed JS contains no secrets — public site key only.
- Widget messages must belong to a widget conversation (`contact_id` `widget:…` or metadata channel/surface).

## Files

- `/embed/widget.js` — public script (`apps/dashboard/app/embed/widget.js/route.ts`)
- `/api/widget/*` — session, message, tools, listings.search
- Settings GET/POST `rotate_widget_key` / `update_widget_origins`
