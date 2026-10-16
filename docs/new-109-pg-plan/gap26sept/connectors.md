# Connectors Page Audit

## Status: working

**Tracker (connectors P1):** 🟢 Detail page connect button now also refuses to open the popup when `oauthConfigured === false` (shows `missingConfigReason` with the live `nangoUiUrl`, no hardcoded localhost). Grid cards show a "Needs setup" badge for unregistered OAuth apps. 🟢 Interactive API Runner works for every registry connector through the generic read-only Nango ping; `microsoft-outlook` and `microsoft-calendar` gained real Graph ping specs, and `connector-ping-coverage.test.ts` fails if a live OAuth connector has no ping spec (quickbooks exempt: needs a per-company realmId). 🟡 Per-connector typed test forms (beyond the 7 hand-written specs) are not added: there are no executors behind them. Not exercised in a live browser.

**Tracker:** 🟢 Grid click on a connector with `oauthConfigured === false` now shows the `missingConfigReason` notice instead of opening a popup that can only fail. Not exercised in a live browser.

This audit covers only the `/connectors` frontend page and its two client
components — `apps/dashboard/app/(dashboard)/connectors/page.tsx` (directory
grid) and `apps/dashboard/app/(dashboard)/connectors/[id]/page.tsx` (per-connector
detail/test page) — plus the client helper `apps/dashboard/lib/nango-client.ts`
they call. `integrations-connectors.md` in this same folder already audits the
backend (`connector-registry.ts`, `integrations-catalog.ts`, `nango-server.ts`,
`api/integrations/*`) in depth; this file does not repeat those findings except
where the frontend's wiring changes the verdict.

---

## What works (file:line evidence)

1. **Real data fetch, no fabricated state** —
   `apps/dashboard/app/(dashboard)/connectors/page.tsx:109-126` (`fetchIntegrations`)
   calls `GET /api/integrations` and renders whatever `data.integrations` and
   `data.stats` return. No client-side mock/fallback list; an empty response
   renders the "No Connectors Found" empty state (`page.tsx:362-367`), not fake
   cards.
2. **Nango public key gate surfaced to the user** — `page.tsx:107,117-119,242-253`
   reads `data.nango.publicKeyConfigured` and renders an amber banner
   ("Nango public key is not configured... Darex will not fake a connection")
   when false. This matches the backend honesty behavior described in
   `integrations-connectors.md` finding #2.
3. **Auth-mode branching drives the correct action** —
   `handleToggleConnection` (`page.tsx:153-197`) branches on
   `item.authMode`: `service_account` → shows the operator hint and refuses to
   attempt a connect (`page.tsx:166-170`); `byok`/`whatsapp` → opens the
   WhatsApp modal (`page.tsx:171-172`, form at `page.tsx:448-478`); `api_key`/
   `razorpay` → opens the Razorpay modal (`page.tsx:173-174`, form at
   `page.tsx:480-514`); required `extraConnectFields` → opens a generic extra-
   fields modal before OAuth (`page.tsx:175-177`, `516-557`); otherwise falls
   through to real Nango OAuth (`page.tsx:179-188`).
4. **WhatsApp BYOK is verified, not accepted blindly** —
   `handleManualWhatsAppConnect` (`page.tsx:132-151`) calls
   `connectWhatsAppByok` (`nango-client.ts:185-`), which posts to the
   integrations route; the UI only shows success after `result.success` comes
   back from the server-verified Meta Graph check (per
   `integrations-connectors.md` finding #1's server-side verification).
5. **Razorpay BYOK verified before "connected"** — the Razorpay modal
   (`page.tsx:487-511`) calls `connectRazorpayByok` and only flips state on a
   server-confirmed `result.success`.
6. **Disconnect is a real mutation** — `handleToggleConnection` branch at
   `page.tsx:158-165` calls `disconnectProvider(item.id)`
   (`nango-client.ts:168-181`), which does `POST /api/integrations` with
   `{ provider, action: 'disconnect' }`, then refetches
   (`page.tsx:165`/`193`). Both the directory grid and the detail page
   (`[id]/page.tsx:272-278`) use the same helper, so disconnect behavior is
   consistent across both surfaces.
7. **Live status refresh, not one-shot** — Both pages expose a manual refresh:
   directory grid `page.tsx:287-293` (button re-invokes `fetchIntegrations`),
   detail page `[id]/page.tsx:418-423`. The detail page also re-runs
   `checkConnectionStatus()` after every connect/disconnect/test action
   (`[id]/page.tsx:277,294,303,314,318,341`) so status never goes stale after
   a mutation.
8. **Per-connector detail page is data-driven, not hardcoded** —
   `checkConnectionStatus` (`[id]/page.tsx:234-260`) fetches `/api/integrations`
   and overlays the live `connected`, `authMode`, `oauthConfigured`,
   `missingConfigReason`/`operatorHint`, `name`, `desc`, and
   `extraConnectFields` onto (or over) the static `CONNECTOR_SPECS` fallback
   table (`[id]/page.tsx:59-195`), so the operator hint and auth-mode gating
   reflect live backend state, not just the hardcoded spec.
9. **Interactive test runner executes a real proxied call** — `handleRunAction`
   (`[id]/page.tsx:324-347`) posts to `POST /api/integrations/test` with the
   real `provider` and constructed `payload`, then calls `checkConnectionStatus()`
   again so any health-state change from that ping is reflected immediately.
10. **Database logs tab is live, filtered per-connector** —
    `[id]/page.tsx:252-253` filters `data.logs` (`channel_logs`) by
    `channel_type === connectorId` and renders each entry's status code,
    event type, timestamp, and message (`[id]/page.tsx:686-696`); it shows an
    honest "No logs recorded yet" empty state rather than fabricating rows.
11. **Accessibility wiring** — `page.tsx:1,40,240` uses `<LiveRegion>` to
    announce `statusNotification.message` for screen readers on every
    connect/disconnect outcome.

---

## What's broken (file:line, exact symptom)

1. **Directory grid's `handleToggleConnection` silently no-ops for
   `oauthConfigured === false` providers routed through the plain OAuth
   branch** — `page.tsx:179-188`: if `item.authMode` is `oauth` (not
   `service_account`/`byok`/`api_key`) and it has no *required*
   `extraConnectFields`, the code goes straight to `startRealNangoOAuth`
   even when `item.oauthConfigured === false`. The user only finds out the
   client ID is missing after the popup opens and fails
   (`nango-client.ts` returns an error string), rather than being blocked
   up front the way the `service_account` branch is. The detail page does
   check `oauthConfigured` for its banner (`[id]/page.tsx:449-453`), but the
   directory grid card has no equivalent per-card warning — it renders the
   generic "Connect OAuth" button regardless of `oauthConfigured`.
2. **Detail page `testFieldsFromApi` typing gap** — `[id]/page.tsx:349`
   (`const testFields = spec?.testFields?.length ? spec.testFields :
   testFieldsFromApi`) means any connector *not* in the hardcoded
   `CONNECTOR_SPECS` map (i.e. any of the other ~19 connectors the registry
   backend supports per `integrations-connectors.md`'s "27 business tools")
   falls back entirely to `extraTestFields` from the API. If the
   `/api/integrations` response for that connector never sets
   `extraTestFields`, the test runner renders zero input fields and
   `handleRunAction` posts an empty `payload` — the interactive runner is
   effectively non-functional for any connector outside the 7 hardcoded
   specs (`whatsapp`, `gmail`, `google-calendar`, `hubspot`, `razorpay`,
   `meta-ads`, `google-ads`).
3. **No loading/error boundary on `[id]/page.tsx` for an unknown
   `connectorId`** — `[id]/page.tsx:201-202` (`const spec =
   CONNECTOR_SPECS[connectorId]`) can be `undefined`; the component falls
   back field-by-field (`spec?.name || connectorId`, etc.) rather than
   showing a 404, so a mistyped or stale `/connectors/<id>` URL renders a
   page with a generic `Key` icon and empty env vars/scopes sections
   instead of an explicit "unknown connector" state.
4. **Category filter dropdown is a flat static list, not derived from data**
   — `CATEGORIES` (`page.tsx:59-78`) is a hardcoded array of 17 category
   strings. If the backend catalog adds a new category value, filtering by
   it in the UI is impossible until this array is manually updated to match
   — a silent content/behavior mismatch, not a crash.

---

## What's missing vs full product vision

1. **No per-card OAuth-readiness indicator in the grid.** The detail page
   shows an amber "operator hint" banner when `oauthConfigured === false`
   (`[id]/page.tsx:449-453`), but the directory grid (the page most admins
   will actually browse) gives no visual signal that 8 of 14 connectors
   (per `integrations-connectors.md` finding #2) will fail before they click
   "Connect."
2. **No multi-account UI.** Both pages assume one connection per provider
   (`item.connected` is a boolean, not a list). `integrations-connectors.md`
   already documents the schema-level single-account constraint; the
   frontend has no account-picker or "+ Add another account" affordance to
   surface even after that schema is fixed.
3. **No health/latency display on the grid or detail header.** The detail
   page's "Test & Run" flow exists, but there is no persistent health badge
   (last successful ping, latency, revoked-token warning) shown outside the
   Logs tab — an admin has to manually run a test action to learn a token
   was silently revoked.
4. **No bulk actions.** Reconnecting or disconnecting several tools (e.g.
   after rotating a Nango client ID) requires visiting each connector
   individually.
5. **No inline OAuth scope/consent preview before the popup opens** — scopes
   are only shown after the fact in the Credentials & Scopes tab
   (`[id]/page.tsx:630-639`), not as part of the initial connect flow.

---

## What to add for full SaaS

1. Add an `oauthConfigured === false` badge/disabled-state to each grid card
   (not just the detail page), so admins never click into a doomed OAuth
   popup from the directory view.
2. Extend `CONNECTOR_SPECS` coverage (or better, drop the hardcoded map
   entirely) so the Interactive API Runner works for all registry-backed
   connectors, not just the 7 with static specs — read `testFields` fully
   from `/api/integrations` for every provider.
3. Add a 404/"unknown connector" empty state to `[id]/page.tsx` when
   `connectorId` matches neither `CONNECTOR_SPECS` nor a live integration
   from the API.
4. Derive `CATEGORIES` from the fetched `integrations` list (`Array.from(new
   Set(integrations.map(i => i.category)))`) instead of a static array, so
   category filters can't drift from the backend catalog.
5. Add a lightweight health badge (latency + last-checked) to each grid
   card, sourced from the same health columns `integrations-connectors.md`
   proposes adding to `org_connectors` (`health_status`,
   `last_health_check_at`, `last_ping_latency_ms`).

---

## Fix priority

- **P1**: Surface `oauthConfigured === false` per-card in the directory grid
  before the user attempts to connect (item #1 under "What's broken").
- **P1**: Fix/replace hardcoded `CONNECTOR_SPECS` so the Interactive API
  Runner works for every registry connector, not just 7 (item #2).
- **P2**: Add 404 state for unknown `connectorId` on the detail page (item #3).
- **P2**: Derive `CATEGORIES` from live data instead of a static array (item #4).
- **P2**: Add per-card health/latency badges once backend health columns land
  (tracked jointly with `integrations-connectors.md`'s P1 health-check item).
