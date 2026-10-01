# Widget Audit

## Status: working (signed visitor tokens, adaptive poll 5m, pack-aware allowlist, intent rate limit, SSE stream)

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Hard 60s polling cutoff | P0 | `widget-embed-src.ts` | 🟢 Done | Adaptive poll up to 300s. |
| 2 | Unsigned visitor sessionId snooping | P0 | `widget-token.ts`, message/session routes | 🟢 Done | HMAC visitorToken required on GET/POST message + stream. |
| 3 | Missing rate limit on intent | P1 | `widget/intent/route.ts` | 🟢 Done | `denyWebhookIfLimited`; pack-install gate (`orgHasInstalledPack`, 403 deny-all) added before any work. |
| 4 | Real-estate-only tool allowlist | P1 | `widget/_lib.ts` `resolveWidgetToolAllowlist` | 🟢 Done | Core kb/faq + pack-conditional listings. |
| 5 | Public SSE stream | P2 | `widget/stream/route.ts` | 🟢 Done | Redis hub subscribe scoped by signed session. |
| 6 | XSS via innerHTML | P1 | `widget-embed-src.ts` addMsg | 🟢 Done | Uses `textContent` (verified). |

The public chat widget (`/embed/widget.js`, `apps/dashboard/app/api/widget/*`) provides an embeddable client chat script and backend endpoints (`session`, `message`, `listings`, `intent`, `tools`, `stream`).
