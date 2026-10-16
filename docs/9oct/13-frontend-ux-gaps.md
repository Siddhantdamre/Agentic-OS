# Frontend UX gaps: NEW-FRONTEND audit (2026-10-09)

This audit covers the user-facing app in `NEW-FRONTEND/`. It is a separate Next.js 16 repo that proxies
`/api/*` to `apps/dashboard` (`NEW-FRONTEND/next.config.ts:22-37`). Every route under
`NEW-FRONTEND/src/app` and every component it renders was walked. The gap docs in
`docs/new-109-pg-plan/gap26sept/` were cross-checked against what the new UI actually does.

Code wins over docs. Unless a path says otherwise, citations are relative to `NEW-FRONTEND/src/`.
Backend paths start with `apps/dashboard/`.

Companion documents:

- [`14-ux-vision-chat-first.md`](14-ux-vision-chat-first.md): the target chat-first experience and its build order.
- [`01-integrations-status-matrix.md`](01-integrations-status-matrix.md): connector status from the backend side.
- [`15-new-features-spec.md`](15-new-features-spec.md): new feature specs.

## How to read this file

Severity:

| Mark | Meaning |
|---|---|
| **P0** | Misleads the user about what happened (fake success, silently dropped input, wrong amount approved), leaks data, or blocks a core journey. Fix before any real customer uses the app. |
| **P1** | A core journey works but is hard to find, incomplete or inconsistent, or a backend capability exists with no usable UI. |
| **P2** | Polish, consistency, accessibility below AA on secondary surfaces, missing nice-to-have states. |
| **P3** | Cosmetic, copy, or developer-facing leftovers. |

Effort, for one engineer who knows the codebase:

| Mark | Meaning |
|---|---|
| **S** | Under half a day |
| **M** | 1 to 2 days |
| **L** | 3 to 5 days |
| **XL** | More than a week, or needs backend work first |

Each finding has an ID such as `HOME-03`. The full register is in [section 6](#6-consolidated-findings-register).

Method and limits:

- Every non-test file under `src/app`, `src/components`, `src/lib` and `src/mocks` was read or grepped. The app has
  713 files under `src/`, about 35,000 non-test lines and 200 test files.
- Nothing was run against a live backend. `docs/BACKEND-WIRING.md:51` says the same of the wiring itself: "tested with
  mocked fetch and demo mode; it has not been run against a live backend."
- No production build was made for this audit. Bundle notes in [section 5.6](#56-performance) are estimates from
  package sizes in `node_modules`.

---

## 0. Executive summary

The new frontend has a solid, well-tested design system and a careful data layer. Slices hydrate from the API,
writes roll back on failure, and an SSE client reconnects with backoff (`lib/state/live-load.ts`,
`lib/realtime/client.ts`). Most tabs are honestly wired: they show a real error rather than mock rows when the
backend fails.

Five structural problems stand in the way of "the chat is the front door".

1. **There are two chat products, and the default one bypasses the Ask AI pipeline.**
   - The Home default view is a third-party TrueForge `Thread` pinned to one agent named `darex-ai`
     (`components/home/home-screen.tsx:113-121`, `components/chat/trueforge-chat.tsx:122-137`).
   - The backend proxy chooses the Executive employee for every TrueForge turn
     (`apps/dashboard/app/api/trueforge/[...path]/route.ts:54`).
   - The native Ask AI client has plan cards, inline approvals, the Auto / Pick one / Team mode selector,
     hand-offs, saved conversations, feedback and usage-cap handling (`lib/state/chat.ts`,
     `components/home/plan-card.tsx`). It is only reachable from the "Dashboard Overview" toggle. There it renders
     inside a panel capped at `min(24rem, 40dvh)` (`components/home/assistant-overlay.tsx:47`).
   - `/chat` and `/ask-ai` both redirect to `/home` (`app/(app)/chat/page.tsx:7`, `next.config.ts:16`).
2. **Several controls report success that did not happen.**
   - The chat bar's attach button accepts a file, shows it as a chip, then throws it away on send
     (`components/ui/chat-bar.tsx:72-77,90-97`). This bar is also the customer-reply box in Conversations
     (`components/conversations/thread-panel.tsx:258`).
   - The microphone types a hardcoded sentence after a timer (`components/ui/chat-bar.tsx:15,59-68`).
   - The Home "Invite your team" dialog says "Invite sent" and sends nothing (`components/home/invite-dialog.tsx:70`,
     `components/home/sticky-checklist.tsx:55-59`).
   - The quote dialog toasts "Quote approved at ₹X", but the edited amount never reaches the backend
     (`components/actions/actions-view.tsx:169-172`, `lib/state/approvals.ts:21-36`, `lib/api/actions.ts:169-180`).
   - Most Settings fields save only to `localStorage` behind a "Saved on this device" toast
     (`lib/state/settings.ts:115`, `components/settings/use-save-setting.ts:36`).
3. **Approvals are scattered and incomplete.**
   - Actions attention cards offer Approve but no Reject for non-quote items (`components/actions/attention-card.tsx:52-60`).
   - Observability shows the same decisions with both buttons (`components/observability/observability-view.tsx:83-95`).
   - Chat tool approvals show only the tool name, never the arguments (`components/home/assistant-overlay.tsx:83-95`,
     `lib/api/ask-ai.ts:122-127`).
   - No approval surface shows a risk level, a preview of what will be sent, or an expiry.
4. **Live-mode copy still says "demo".**
   - The landing page says "Demo data only" and "Demo build" (`components/landing/landing-content.ts:24`,
     `components/landing/landing.tsx:94`).
   - The privacy page says sign-in is a mock and nothing is sent to a server (`app/legal/privacy/page.tsx:8-10`), and
     signup requires agreeing to these placeholder terms (`components/onboarding/auth-form.ts:11`).
   - Home shows "Learning your business" percentages computed from a file count
     (`lib/state/selectors.ts:17-26`) and a "Meetings Booked" tile that is always a dash
     (`components/home/snapshot-card.tsx:22`).
5. **Global affordances are missing.**
   - There is no notification inbox outside the Conversations page (`components/conversations/bell-popover.tsx` is
     mounted only in `conversations-view.tsx:80,126`).
   - There is no search or command palette, and no user menu, org switcher or role-aware navigation in the shell
     (`components/layout/app-shell.tsx`, `components/layout/icon-rail.tsx`).
   - There is no PWA manifest or service worker (`public/` holds only `art/`, `darex-icon.svg`, `darex-logo.svg`).
   - The session object carries no role (`lib/state/auth.ts:14-21`), so no page outside Settings can hide what a
     member cannot do.

The ten fixes with the best return, in order:

| # | Fix | IDs | Effort |
|---|---|---|---|
| 1 | Make the native Ask AI client the full-screen default on Home, and retire or demote the TrueForge thread | CHAT-01, CHAT-02 | L |
| 2 | Remove or wire every fake control: attach, mic, Home invite, quote amount, local-only settings | CHAT-05, CHAT-06, HOME-04, ACT-02, SET-01 | M |
| 3 | Add Reject to every approval surface and show arguments, risk and expiry | ACT-01, CHAT-04 | M |
| 4 | Put the role in the session and gate controls app-wide | X-RBAC-01 | M |
| 5 | Handle `VERIFY_EMAIL` / `EMAIL_NOT_VERIFIED` and add a visible email sign-in | AUTH-01, AUTH-02 | M |
| 6 | Replace demo copy on landing, legal and Home with live-aware copy | LAND-01, LEGAL-01, HOME-02 | S |
| 7 | Add a global notification inbox fed by the SSE stream | X-NOTIF-01 | M |
| 8 | Add a Cmd/Ctrl+K command palette that can also hand a sentence to chat | X-NAV-02 | M |
| 9 | Unify Conversations into one inbox with filters, instead of employee-first navigation | CONV-01 | L |
| 10 | Show blank-screen guards as skeletons and keep the deep link on sign-in redirect | X-GUARD-01, X-GUARD-02 | S |

---

## 1. How the frontend is put together

This section is context for the findings. It records the facts the rest of the document relies on.

### 1.1 Route groups and shells

| Group | Layout | Guards | Shell |
|---|---|---|---|
| `(flow)` | `app/(flow)/layout.tsx:5-11` | `RedirectIfDone`, and `RequireAuth` for onboarding (`app/(flow)/onboarding/layout.tsx:6-7`) | Plain `main` on cream, no rail |
| `(app)` | `app/(app)/layout.tsx:8-19` | `RequireAuth` then `RequireOnboarded` | `AppShell` with logo header and `IconRail` (`components/layout/app-shell.tsx:13-36`) |
| `(platform)` | `app/(platform)/layout.tsx:12-20` | `RequireAuth` then `PlatformGuard` | `PlatformShell` with its own nav (`components/platform/platform-shell.tsx`) |
| Root pages | `app/page.tsx`, `app/legal/*`, `app/not-found.tsx` | none | Landing or plain pages |

`ImpersonationBanner` and `RealtimeBridge` mount inside the `(app)` guards (`app/(app)/layout.tsx:13-14`).

### 1.2 Navigation

The rail has eight entries (`lib/routes.ts:13-22`):

- Home `/home`
- AI Employees `/ai-employees`
- Conversations `/conversations`
- Actions `/actions`
- Opportunities `/opportunities`
- Insights `/insights`
- Integrations `/integrations`
- Settings `/settings/profile`

Sub-areas are reached through in-page tabs or sub-navs:

- **Insights:** Insights, Observability, Plans (`components/insights/insight-subnav.tsx:5-9`).
- **Opportunities:** Pipeline, Listings, Showings, Inquiries, Rent (`components/real-estate/real-estate-tabs.tsx:10-16`).
- **Settings:** seven tabs (`lib/routes.ts:30-38`).

Legacy routes redirect: `/login`, `/ask-ai`, `/employees`, `/analytics` (`next.config.ts:13-20`), and
`/plans` (`app/(app)/plans/page.tsx:3-5`).

Old dashboard tabs map onto the new IA like this:

| Old tab (gap26sept) | New location |
|---|---|
| Home / dashboard-home | `/home`, Dashboard Overview toggle |
| Ask AI | `/home`, AI Chat toggle (TrueForge) or the overview's ask bar (native) |
| Conversations | `/conversations` |
| Employees, Growth, Customer | `/ai-employees` plus details drawer (Growth tab for sales-like roles) |
| Work Items, Brief | `/actions` (Morning Brief and Tasks tabs, work-item drawer) |
| Plans | `/insights/plans` |
| Analytics | `/insights` (performance section) |
| Observability / Health | `/insights/observability` |
| Brain | Settings > Business > Knowledge |
| Connectors, Integrations | `/integrations` and Settings > Integration |
| Packs, Skills | Employee details drawer tabs |
| Autonomy | Settings > AI Workforce |
| Audit log, DSR | Settings > Security cards |
| Billing | Settings > Billing |
| Listings, Showings, Inquiries, Rent | `/opportunities` tabs |
| Insight | `/insights` list |

### 1.3 Data layer

- `api<T>()` wraps `fetch`. A 401 outside `/api/auth/` fires the global unauthorized handler (`lib/api.ts:19-43`).
- `isDemo` is true when `NEXT_PUBLIC_DEMO=1` or under Vitest (`lib/demo.ts:2-3`). Every slice branches on it.
- Slices use `createSlice` (`lib/state/create-slice.ts:71-145`). They persist to `localStorage` under `dare.v1.<key>`
  by default (`:75`, `:97-104`), unless a slice passes `persist: false`.
- Live list slices hydrate through `createLoader` (`lib/state/live-load.ts:42-89`). Failed writes go through
  `reportError` to a toast, but only on views that mount `useLiveErrorToasts` (`:25-32`).
- Panel-local reads use `useRemote` (`lib/state/remote.ts:21-74`).
- Two state systems therefore co-exist: global slices for lists, `useRemote` for drawers.

### 1.4 Realtime

- One SSE stream per session from `GET /api/stream/events`. It uses exponential backoff, honours 429
  `Retry-After` and stops on 401 (`lib/realtime/client.ts:26-85`).
- Events refresh five targets only: `threads`, `thread`, `approvals`, `activity` and `work`
  (`lib/realtime/events.ts:31-49`, `lib/state/realtime.ts:36-57`).
- Bell notices are produced only for `message_received`, `needs_attention` and `conversation_takeover_updated`
  (`lib/realtime/events.ts:54-66`).
- The backend publishes more event types than the frontend handles. `gap26sept/00-workspace-connectivity.md:320`
  lists `listing_updated`, `billing_updated`, `integration_updated`, `settings_updated`, `memory.updated`,
  `inquiry_updated` and `inquiry_deleted`. NEW-FRONTEND ignores all of them.
- The only visible connection state is a "Polling fallback" pill (`components/layout/realtime-bridge.tsx:7-19`).
  "Retrying" and "signed-out" statuses are never shown.

### 1.5 Auth and roles

- The live session comes from `GET /api/auth/session` and is cached in memory (`lib/state/auth.ts:23-52`).
- `SessionState` holds `status`, `email`, `userId`, `onboardingComplete` and `error`. **It has no role, org name or
  org id** (`lib/state/auth.ts:14-21`).
- Role checks exist only inside some Settings cards, which read `canManage`-style flags from their own endpoints
  (see [3.15](#315-settings)). They do not come from a shared source.

### 1.6 Two chat stacks

| | Native Ask AI client | TrueForge thread |
|---|---|---|
| Entry | Home > Dashboard Overview > ask bar (`components/home/home-chat.tsx:121`) | Home > AI Chat, the default view (`components/home/home-screen.tsx:31-33,113-121`) |
| Transport | `POST /api/ask-ai` NDJSON, `/api/ask-ai/plan`, `/execute` SSE, `/approve`, `/feedback`, `/conversations` (`lib/state/chat.ts`) | `/api/trueforge/*` proxied to the TrueForge sidecar (`components/chat/trueforge-chat.tsx:10-13`) |
| Employee routing | Auto / Pick one / Team, `@`-free, persisted per conversation (`lib/state/chat.ts:389-406`, `components/home/ask-mode-picker.tsx`) | Fixed `agentName="darex-ai"`; the backend picks the Executive employee (`apps/dashboard/app/api/trueforge/[...path]/route.ts:54`) |
| Plans | Plan card: toggle, edit step, revise, approve, stop, save as playbook (`components/home/plan-card.tsx`) | None |
| Tool approvals | Allow / Deny on the paused tool (`components/home/assistant-overlay.tsx:83-95`) | Whatever the TrueForge UI renders; not integrated with Darex approvals or audit |
| History | Saved conversations: open, rename, delete (`components/home/chat-history-menu.tsx`) | TrueForge's own threads; the Darex history menu does not list them |
| Rendering | Plain text with `whitespace-pre-wrap`; tools listed as "Used: a, b" (`components/home/assistant-overlay.tsx:69-71`) | Markdown, tool cards, charts (TrueForge UI package) |
| Size | Panel capped at `min(24rem,40dvh)` (`:47`) | Full height |

The two stacks overlap in purpose and diverge in behaviour. The vision document picks one direction for them.

---

## 2. Route inventory

| Route | Component | Main APIs | Data | Loading | Empty | Error | Realtime | RBAC in UI |
|---|---|---|---|---|---|---|---|---|
| `/` | `components/landing/landing.tsx` | none | Static copy | n/a | n/a | n/a | no | n/a |
| `/sign-in` | `components/onboarding/sign-in-actions.tsx`, `auth-dialog.tsx` | `/api/auth/login`, `/signup`, `/oauth/*`, `/sso`, `/mfa` | Live | Busy label | n/a | Inline alert | no | n/a |
| `/forgot-password`, `/reset-password` | `forgot-password-form.tsx`, `reset-password-form.tsx` | `/api/auth/forgot-password`, `/reset-password` | Live | Busy label | n/a | Field error, not announced | no | n/a |
| `/invite/[token]` | `components/onboarding/invite-accept.tsx` | invite fetch / accept | Live | Skeleton | n/a | Yes | no | n/a |
| `/onboarding/[step]`, `/onboarding/ready` | `onboarding-step.tsx`, `workspace-ready.tsx` | `PATCH /api/org/onboarding`, `POST /api/onboarding/complete` | Partly local | `null` | n/a | Toast at the end only | no | n/a |
| `/home` | `components/home/home-screen.tsx` | `/api/dashboard/stats`, `/api/employees`, `/api/integrations`, `/api/decisions`, `/api/work-items`, `/api/ask-ai*`, `/api/trueforge/*` | Mixed (mock stats on mini cards, fabricated learning %) | Partial | Partial | Partial | approvals and activity only | none |
| `/ai-employees` | `components/ai-employees/employees-view.tsx` | `/api/employees`, `/api/employees/stats`, details endpoints | Live | `null` | Yes | Yes | no | none |
| `/conversations` | `components/conversations/conversations-view.tsx` | `/api/conversations*`, `/api/stream/presence` | Live (overview stats demo-only) | `null` | Yes | Yes | yes | none |
| `/actions` | `components/actions/actions-view.tsx` | `/api/decisions`, `/api/work-items*`, `/api/brief*` | Live | `null` | Yes | Toast | approvals, work, activity | none |
| `/opportunities` | `components/opportunities/opportunities-view.tsx` and `components/real-estate/*` | `/api/growth/*`, `/api/listings*`, `/api/showings*`, `/api/inquiries*`, rent endpoints | Live (case studies hardcoded) | Skeleton | Yes | Yes | no | none |
| `/insights` | `components/insights/insights-view.tsx` | insights, `/api/analytics*` | Live (two of four KPIs always "-") | Skeleton | Yes | Toast | no | none |
| `/insights/observability` | `components/observability/observability-view.tsx` | `/api/observability/*`, `/api/decisions` | Live | Skeleton | Yes | Yes | approvals only | none |
| `/insights/plans` | `components/plans/plans-view.tsx` | `/api/ask-ai/plan` | Live | Skeleton | Yes | Yes | no | none |
| `/integrations` | `components/integrations/integrations-view.tsx` | `/api/integrations*`, Nango, `/api/settings` | Live (stats partly invented) | Two skeletons | Filter only | Alert plus a misleading grid | no | none |
| `/settings/[tab]` | `components/settings/settings-shell.tsx`, `tab-content.tsx` | `/api/settings`, `/api/billing*`, `/api/brain*`, `/api/auth/mfa`, `/api/onboarding*`, `/api/settings/*`, `/api/dsr*`, `/api/audit-logs` | Mixed (most fields local only) | Per card | Per card | Banner plus toasts | no | Some cards |
| `/admin/*` | `components/platform/*` | `/api/platform/*` | Live | Skeleton | Yes | Some without retry | no | Guard plus operator/support role |
| `/legal/*` | `components/landing/legal-page.tsx` | none | Placeholder demo copy | n/a | n/a | n/a | no | n/a |

---

## 3. Per-page findings

Every subsection follows the same order:

1. What the page shows.
2. APIs it calls.
3. Whether the data is real.
4. Loading, empty and error states.
5. Realtime.
6. RBAC.
7. Mobile.
8. Accessibility.
9. Dead or placeholder controls.
10. Inconsistencies.

A findings table closes each subsection.

### 3.1 Landing page (`/`)

**What it shows.** `components/landing/landing.tsx` has seven parts:

- a header with section anchors and a mobile sheet;
- a hero with headline, subtitle, CTAs and a note;
- six feature cards;
- three "How it works" steps;
- a "Works with" logo strip;
- a closing CTA;
- a footer.

Copy lives in `components/landing/landing-content.ts:20-58`.

**APIs.** None. The CTAs read the auth and onboarding slices to choose their labels:

- "Sign up" and "Log in" when signed out;
- "Continue setup" when onboarding is unfinished;
- "Open dashboard" when it is done.

See `components/landing/landing-actions.tsx:16-32`.

**Real or mock.** The copy is static. Three lines are wrong for a live product:

- "No credit card. Demo data only." (`landing-content.ts:24`)
- "Demo build" in the footer, unconditional (`landing.tsx:94`)
- Step 1, "Connect your tools: Link WhatsApp, email, ads, payments and your CRM", describes something onboarding does
  not do (`landing-content.ts:43`; see [3.3](#33-onboarding-and-workspace-ready)).

**States.** The page server-renders the signed-out CTAs, then swaps them in on the client. A signed-in visitor sees the
labels change after load (`landing-actions.tsx:16`).

**Mobile and accessibility.**

- Anchors smooth-scroll and move focus to the section `h2` (`landing-header.tsx:15-23`). That is good.
- The mobile sheet closes on Escape but has no focus trap and no outside-click close (`landing-header.tsx:31-40,53-88`).
- The sheet lists "Log in" before the primary CTA (`:82-87`).
- Reveal animations respect `useReducedMotion` (`components/landing/reveal.tsx:8`).

**Dead controls.** None found. Both "Sign up" and "Log in" go to `/sign-in` (`landing-actions.tsx:29-32`). On that
page, "Log in" has no visible email path (see AUTH-02).

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| LAND-01 | P1 | Live landing page says "Demo data only" and "Demo build" | `landing-content.ts:24`, `landing.tsx:94` | Gate both strings on `isDemo`. In live mode show a real pricing note, or nothing. | S |
| LAND-02 | P2 | "Connect your tools" step promises something onboarding does not do | `landing-content.ts:43` | Either add connecting tools to onboarding (see the vision doc, onboarding wizard) or reword the step to "Connect your tools from chat or Integrations". | S |
| LAND-03 | P2 | Sign up and Log in go to the same page, which has no visible email login | `landing-actions.tsx:29-32` | Send Log in to `/sign-in?mode=signin` and Sign up to `/sign-in?mode=signup`; open the matching form. | S |
| LAND-04 | P3 | CTA label flashes for signed-in visitors | `landing-actions.tsx:16` | Render a neutral skeleton pill until the session is known. | S |
| LAND-05 | P2 | Mobile header sheet has no focus trap or outside-click close | `landing-header.tsx:53-88` | Reuse the `Modal` primitive (`components/ui/modal.tsx`) or add a focus trap. | S |
| LAND-06 | P3 | "Works with" logos imply working connectors (Meta Ads, Google Ads, HubSpot) without checking status | `landing-content.ts:47-55` | Show only connectors marked green in `01-integrations-status-matrix.md`, or label them "coming soon". | S |

### 3.2 Sign-in, sign-up, password recovery, invite

**What it shows.** `/sign-in` has three kinds of control:

- Google and GitHub buttons (`components/onboarding/sign-in-actions.tsx:63-66`);
- SSO buttons in live mode only (`components/onboarding/sso-buttons.tsx:9-35`);
- a "Create an account" button that opens `AuthDialog` in signup mode (`sign-in-actions.tsx:75-77`).

Email sign-in is reachable only through the "Sign in" switch inside that signup dialog (`auth-dialog.tsx:94-101`).

**APIs.**

- `POST /api/auth/login` and `/signup` (`lib/api/auth.ts:41-60`)
- OAuth redirect `/api/auth/oauth/<provider>` (`:78-81`)
- `GET /api/auth/sso`
- forgot and reset password (`lib/api/team.ts:188-189`)
- invite fetch and accept (`components/onboarding/invite-accept.tsx`)

**Real or mock.** Live calls throughout. In demo mode, every button just flips a flag (`sign-in-actions.tsx:42-48`).

**States and errors.**

- Errors show in one `role="alert"` paragraph with the raw backend message (`auth-dialog.tsx:62,81-85`). Users can
  see strings such as "Unauthorized" (`lib/api.ts:36-40`).
- MFA switches the dialog to a code step (`auth-dialog.tsx:50-55`). Problems with that step:
  - the field allows 10 characters while the copy says "6-digit" (`:71`);
  - there is no "back" or "use another account" control;
  - there is no recovery-code option.
- **`VERIFY_EMAIL` (202) and `EMAIL_NOT_VERIFIED` (403) are not handled anywhere.** `BUILD_STATE.md` (2026-10-05,
  "Password signups verify their email address") says the frontend must handle both before
  `REQUIRE_EMAIL_VERIFICATION` is turned on. Today:
  - a 202 signup is treated as signed in (`lib/api/auth.ts:54-60`, `lib/state/auth.ts:74-78`);
  - the user then goes into onboarding;
  - the first onboarding PATCH gets a 401, which flips the session to "out" (`lib/api.ts:34`, `lib/state/auth.ts:29-31`);
  - the user lands back on sign-in with no message.
  - There is no `/verify-email` page.

**Accessibility.**

- `autoComplete` is correct on email, password and OTP (`auth-dialog.tsx:74-75,71`).
- There is no show-password toggle anywhere.
- Field errors in `TextPill` (forgot and reset) are linked by `aria-describedby` but are not live regions
  (`components/ui/text-pill.tsx:35-37`).
- The reset form puts every error, including the length rule, on the confirm field (`reset-password-form.tsx:71`).

**Inconsistencies.**

- Two email validators disagree: signup uses `auth-form.ts:3` and forgot-password uses `lib/validators.ts:29`.
- Provider names are lowercase in the buttons: "Sign in with google" (`sign-in-actions.tsx:21-22`).
- Google and GitHub buttons render even when the provider is not configured. They fail only after a click
  (`sign-in-actions.tsx:51-52`).

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| AUTH-01 | P0 (when the flag is on) | Email verification responses are not handled; the user loops back to sign-in silently | `lib/api/auth.ts:45-60`, `lib/state/auth.ts:74-78` | Map 202 `VERIFY_EMAIL` to a "Check your inbox" state with Resend (`POST /api/auth/resend-verification`). Map 403 `EMAIL_NOT_VERIFIED` to the same state. Add `/verify-email?token=` calling `POST /api/auth/verify-email`. | M |
| AUTH-02 | P1 | Returning password users cannot see an email sign-in | `sign-in-actions.tsx:75`, `auth-dialog.tsx:94-101` | Add a primary "Sign in with email" button, and keep "Create an account" as secondary. Honour `?mode=`. | S |
| AUTH-03 | P2 | Raw backend error strings shown to users | `auth-dialog.tsx:62`, `lib/api.ts:36-40` | Map known codes (`INVALID_CREDENTIALS`, `RATE_LIMITED`, `MFA_INVALID`) to plain copy. Keep the raw text in a details line. | S |
| AUTH-04 | P2 | OAuth buttons shown for providers that are not configured | `sign-in-actions.tsx:51-52` | Fetch provider availability with the SSO list and hide or disable unconfigured providers with a reason. | S |
| AUTH-05 | P2 | MFA step: 10-character field vs "6-digit" copy; no back; no recovery codes | `auth-dialog.tsx:38,71,94` | Set `maxLength=6` and `pattern=\d{6}`, add "Use a different account", and add recovery-code entry once the backend supports it. | S |
| AUTH-06 | P2 | No show-password toggle; reset errors attached to the wrong field | `reset-password-form.tsx:70-71`, `recovery-validation.ts:11` | Add a reveal button to the password input. Attach the length error to the first field. | S |
| AUTH-07 | P3 | Two email regexes | `auth-form.ts:3`, `lib/validators.ts:29` | Use `validateEmail` everywhere. | S |
| AUTH-08 | P3 | Lowercase provider names | `sign-in-actions.tsx:21-22` | "Sign in with Google" / "GitHub". | S |

### 3.3 Onboarding and workspace ready

**What it shows.** Eight steps (`components/onboarding/onboarding-steps.ts:6-15`, `lib/types.ts` `STEP_SLUGS`):

1. intro, which auto-advances;
2. name;
3. business name;
4. business type;
5. team size;
6. challenge;
7. channels;
8. goal.

Then the "Your workspace is ready" screen, whose only control is a chat bar
(`components/onboarding/workspace-ready.tsx:58-75`).

**APIs.**

- Debounced `PATCH /api/org/onboarding` 600 ms after each edit (`lib/state/onboarding.ts:58,68-82`).
- `POST /api/onboarding/complete` on finish (`lib/api/onboarding.ts:92-94`).

**Real or mock.**

- Name, challenge and goal never reach the backend (`lib/api/onboarding.ts:5-6,47-55`). They live in `localStorage`
  (`dare.v1.onboarding`), so they are lost on a new device.
- The channels step stores labels only. It does not start any connection (`components/onboarding/channels-step.tsx:33-77`).
- No step creates an AI employee or connects a tool.

**States.**

- Steps render `null` while blocked or loading (`onboarding-step.tsx:58`); the ready screen does the same (`workspace-ready.tsx:55`).
- Save failures are stored in `lastSaveError`, but `pendingSaveError()` is never called (`lib/state/onboarding.ts:77-79,141-143`).
  The user learns of a failure only through a toast at the very end (`workspace-ready.tsx:34-37`).
- `wizardStep` reports "channels" when every step is answered (`lib/state/onboarding.ts:62-64`).

**Accessibility.**

- There is no progress indicator. The plant art is the only cue, and it is `aria-hidden` (`components/layout/plant-growth.tsx:18-33`).
- The intro auto-advances after 3 s or on any document click (`components/onboarding/intro-step.tsx:20-25`,
  `lib/timings.ts:11`), against WCAG 2.2.1 (Timing Adjustable).
- Choice steps auto-advance 400 ms after a pick (`choice-step.tsx:61`).
- Focus hand-off between steps is good (`onboarding-step.tsx:37-51`).

**Hand-off to chat.**

- The ready screen's chat bar has `allowEmpty`, so sending nothing is how the user finishes (`workspace-ready.tsx:73-75`).
- Any typed text is sent with `send(text)` without awaiting, and the user is pushed to `/home` (`:39-41`).
- `/home` opens on the TrueForge view, not the native chat where that message went
  (`components/home/home-screen.tsx:31-33`). **The first message a new user types lands in a chat they cannot see.**
  It only appears if they switch to Dashboard Overview, where `home-chat.tsx:34-39` opens the overlay once history arrives.

**Copy.**

- Typo: "What do we call you ?" (`onboarding-steps.ts:8`).
- Business type "Profession" (`lib/types.ts:11`).
- The team-size buckets jump from "6-20" to "50+" (`lib/types.ts:15`).

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| ONB-01 | P0 | The first message typed on the ready screen is invisible on Home's default view | `workspace-ready.tsx:39-41`, `home-screen.tsx:31-33,113-121` | Make the native chat the Home default (CHAT-01), or route the ready message into the same chat surface the user lands on. | S after CHAT-01 |
| ONB-02 | P1 | Onboarding connects no tools and creates no employee; "channels" is a label picker | `channels-step.tsx:33-77` | Turn the channels step into a connect step that reuses `ConnectDialog` (`components/integrations/connect-dialog.tsx`). Add a "meet your team" step that shows the seeded roster and lets the user switch roles off. Better still, move this into chat (vision doc, section 9). | L |
| ONB-03 | P1 | Name, challenge and goal are local only; save failures are silent | `lib/api/onboarding.ts:5-6,47-55`, `lib/state/onboarding.ts:77-79,141` | Persist all answers server-side (extend `/api/org/onboarding` or user profile). Surface `pendingSaveError()` inline on the next step. | M (needs backend fields) |
| ONB-04 | P2 | No progress indicator for anyone, including screen-reader users | `plant-growth.tsx:18-33` | Add "Step 3 of 8" text and a `progressbar` with `aria-valuenow`. | S |
| ONB-05 | P2 | Intro auto-advances on a timer and on any click | `intro-step.tsx:20-25` | Remove the timer; advance only on the Continue button or Enter. | S |
| ONB-06 | P2 | Blank `null` render while guards resolve | `onboarding-step.tsx:58`, `workspace-ready.tsx:55` | Render the shell with a skeleton. | S |
| ONB-07 | P2 | Finishing means "send an empty message" | `workspace-ready.tsx:73-75` | Add an explicit "Go to my workspace" button. Keep the chat bar for an optional first question. | S |
| ONB-08 | P3 | Copy: stray space, "Profession", bucket gap 21-49 | `onboarding-steps.ts:8`, `lib/types.ts:11,15` | Fix the copy and add a "21-49" bucket mapped to 35. | S |
| ONB-09 | P3 | `wizardStep` wrong when complete | `lib/state/onboarding.ts:62-64` | Send "goal" or "ready" when nothing is missing. | S |

### 3.4 Home (`/home`): overview

**What it shows.** A top bar with an "AI Chat" / "Dashboard Overview" toggle, a "DareX AI Assistant" status dot and a
"New Chat" button (`components/home/home-screen.tsx:55-110`). The overview has three parts:

- **Left column:** greeting, the fixed subline "Your AI workforce is getting ready…" (`home-content.ts:16`), and on
  first run a sticky checklist and an "Integrate" button (`home-screen.tsx:126-139`).
- **Bottom:** the native chat (`HomeChat`) with quick prompts, history menu, mode picker and ask bar
  (`home-chat.tsx:76-122`).
- **Right column (populated state):** five cards, which are dropped from the end when they do not fit
  (`components/home/populated-stack.tsx:13-92`):
  - "Your business is coming online" counters;
  - up to four employee mini cards;
  - Today's Snapshot;
  - Needs Your Attention chips;
  - live activity.

**APIs.**

- `/api/dashboard/stats`, once only (`lib/state/dashboard-stats.ts:17-37`)
- `/api/employees` and `/api/integrations`
- `/api/decisions` plus `/api/work-items`, for approvals and activity (`lib/api/actions.ts:140-166`)
- the settings and brain loaders, for knowledge counts
- the `/api/ask-ai*` family

**Real or mock.**

- **"Learning your business" %** is uploaded files divided by known files. **"Estimated completion N hours"** is
  `18 - (uploaded - 3)` (`lib/state/selectors.ts:17-26`). Both are invented metrics shown as facts
  (`components/home/coming-online-card.tsx:43-47`).
- **Employee mini cards** read stats from `HOME_MINI_STATS` mocks and role labels from the conversations mock
  `replyPoolFor` (`components/home/employee-mini-card.tsx:7-8,15,23`).
  - Live employee ids never match the mock keys, so live cards fall back to `employee.stats`.
  - In live mode that is only `{"Tools enabled": n}` (`lib/api/employees.ts:77`).
  - The mock modules still ship in the bundle.
- **Today's Snapshot:**
  - "Meetings Booked" is always "–" in live mode (`components/home/snapshot-card.tsx:22`).
  - The demo numbers 157 / 18 / "34 sec" sit in `home-content.ts:28-32`.
- **The subline** always says the workforce "is getting ready", even when the page is populated (`home-content.ts:16`).
- **The checklist** has four hardcoded items and lives in `localStorage` (`lib/state/checklist.ts:5-16`).
  - An item ticks when its link is clicked, before the user does anything (`components/home/sticky-checklist.tsx:43`).
  - "Invite your team" opens a mock dialog that says "This is a demo, so no email is sent". It then toasts
    "Invite sent to …" (`components/home/invite-dialog.tsx:14,70`, `sticky-checklist.tsx:55-59`).
  - The real invite flow exists in Settings > Business > Team (`components/settings/invite-dialog.tsx`, `lib/api/team.ts:89-95`).
- **Quick prompts:**
  - "Show connected apps" navigates to /integrations; "Create another employee" navigates to the create panel.
  - "AI Assistant Chat" calls `router.push("/home")` from `/home`, which does nothing visible
    (`components/home/home-chat.tsx:105-113`). `HomeScreen` never passes `onStartChat` (`home-screen.tsx:141`), so
    these buttons never switch to the chat view.
- **"New Chat"** dispatches a window event that only the TrueForge thread listens to (`home-screen.tsx:46-50`,
  `components/chat/trueforge-chat.tsx:99-108`). The native chat has its own "New" inside the history menu.

**States.**

- Stats load once and never refresh. There is no realtime and no interval (`lib/state/dashboard-stats.ts:33-35`).
- The activity feed has no empty state: an empty live feed renders an empty glass card with no heading
  (`components/home/activity-feed.tsx:18-35`).
- A stats error is never shown. `useDashboardStats` returns `error`, and `HomeScreen` ignores it (`home-screen.tsx:37`).
- The first-run versus populated switch waits for three loaders. Until then nothing renders in that area
  (`home-screen.tsx:38,131,144`).

**Realtime.** Approvals and activity refresh through the stream (`lib/state/realtime.ts:47-52`). Stats, employees and
integrations do not.

**RBAC.** None.

**Mobile.**

- `AppShell` uses `h-dvh overflow-hidden` on Home (`app-shell.tsx:15-18`), so the overview cannot scroll past the
  viewport on a short phone. The right column flows below on small screens (`populated-stack.tsx:14-23`).
- The menu button that hides the rail exists only on Home (`icon-rail.tsx:65-67`).

**Accessibility.**

- The greeting is the page `h1` (`greeting.tsx:13`). The top-bar toggles use `aria-pressed` (`home-screen.tsx:62,75`).
- The checklist gives each item two focusable controls: a checkbox with an sr-only label, and a link
  (`sticky-checklist.tsx:36-48`).
- `PopulatedStack` hides cards with inline `display:none` according to the measured height (`populated-stack.tsx:20-37`).
  At desktop height, keyboard and screen-reader users lose cards with no "show more".

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| HOME-01 | P1 | Invented metrics: learning %, hours to completion | `lib/state/selectors.ts:17-26`, `coming-online-card.tsx:43-47` | Replace with real counts: knowledge items indexed (from `/api/brain`), connectors connected, employees active, first conversation handled. Drop "Estimated completion". | S |
| HOME-02 | P1 | Subline says "getting ready" forever | `home-content.ts:16`, `home-screen.tsx:129` | Switch the subline on home state: first-run copy versus "Here is what your team did today". | S |
| HOME-03 | P2 | Mini cards import mocks; live cards show only "Tools enabled" | `employee-mini-card.tsx:7-8,15,23`, `lib/api/employees.ts:77` | Use `/api/employees/[id]/metrics` (already used by `employee-performance-card.tsx`) or `/api/employees/stats`. Remove the mock imports. | M |
| HOME-04 | P0 | Home invite dialog fakes success | `invite-dialog.tsx:14,70`, `sticky-checklist.tsx:55-59` | Reuse the Settings invite dialog and `inviteMember` (`lib/api/team.ts:89-95`). Toast on the real result. | S |
| HOME-05 | P1 | Checklist is local, ticks on click, unrelated to real state | `lib/state/checklist.ts:5-22`, `sticky-checklist.tsx:43` | Derive each item from server state: members > 1, calendar connected, an employee's tone edited, any conversation handled. Make items read-only checkmarks with a "Do it" action, or do them in chat (vision doc). | M |
| HOME-06 | P2 | "Meetings Booked" always a dash | `snapshot-card.tsx:22` | Use showings or calendar bookings count, or replace the tile with "Approvals cleared today". | S |
| HOME-07 | P1 | Quick prompt "AI Assistant Chat" does nothing; other prompts leave chat | `home-chat.tsx:105-113`, `home-screen.tsx:141` | Pass `onStartChat` from `HomeScreen` to switch to chat view, or turn the prompts into chat prompts ("Which apps are connected?"). | S |
| HOME-08 | P2 | Stats never refresh, and errors are ignored | `dashboard-stats.ts:33-35`, `home-screen.tsx:37` | Refresh on `needs_attention`, `work_item_updated` and `plan_updated`. Show an inline error with Retry. | S |
| HOME-09 | P2 | Activity feed has no heading and no empty state | `activity-feed.tsx:18-35` | Add an `h2` "Live activity" and the copy "Nothing yet today". | S |
| HOME-10 | P2 | Cards silently hidden by height fitting | `populated-stack.tsx:20-37` | Make the column scroll, or add "Show N more". | S |
| HOME-11 | P2 | Two "new chat" controls that act on different chats | `home-screen.tsx:46-50`, `home-chat.tsx:92-96` | One chat, one New button (CHAT-01). | S after CHAT-01 |

### 3.5 Ask AI chat (Home "AI Chat" view and the native overlay)

**What it shows.**

*Default view.* `TrueForgeChat` renders the `@truefoundry/trueforge-ui` `TrueForgeUI` with a custom layout that shows
only `Thread` (`components/chat/trueforge-chat.tsx:96-120,163-223`). Its configuration:

- `agentConfig` is `SingleAgent` named `darex-ai` (`:134-137`);
- the theme is locked to light Darex tokens (`:34-74,148-161`).

The proxy at `apps/dashboard/app/api/trueforge/[...path]/route.ts` behaves as follows:

- it picks an employee from the `x-employee-role` / `x-employee-id` headers, which the frontend never sends (`:37-38`);
- without them it takes the Executive, or else the oldest active employee (`:54`);
- it forwards the request with tenant MCP headers (`:83-95`).

*Native client.* `HomeChat` and `AssistantOverlay` show:

- user and assistant bubbles, with plain text and `whitespace-pre-wrap`;
- "handled by" labels;
- a "Used: tool, tool" line;
- sub-agent status lines;
- a status line ("Thinking…", tool status);
- plan cards;
- Allow / Deny for a paused tool;
- a hand-off offer;
- an "Open billing" link on usage cap;
- a Retry on error;
- Helpful / Not helpful votes.

See `components/home/assistant-overlay.tsx:60-133`. The mode picker sits under the quick prompts
(`components/home/ask-mode-picker.tsx:22-57`).

**APIs (native).**

- `POST /api/ask-ai`, which streams NDJSON or returns plan JSON (`lib/state/chat.ts:112-155`)
- `GET /api/ask-ai` for hydrate (`:412-434`)
- `PATCH /api/ask-ai/plan` and `GET /api/ask-ai/execute` SSE (`:168-237`)
- `POST /api/ask-ai/revise` (`:291-299`)
- `POST /api/ask-ai/feedback` (`:301-307,368-387`)
- `POST /api/ask-ai/approve` (`:322-356`)
- `/api/ask-ai/conversations` with GET, POST, PATCH and DELETE (`:438-507`)

**Real or mock.** Live. The demo branch uses canned replies (`lib/assistant.ts`).

**States.**

- The native client streams into a "Thinking…" message and clears a stuck spinner on a dangling stream (`chat.ts:152-153`).
- There is no Stop for a normal streamed reply. Only plans can be stopped (`chat.ts:209-225`), and `liveReply` has no
  `AbortController`.
- Input longer than 2,000 characters is cut silently (`chat.ts:30,69`).
- The overlay height is capped at `min(24rem,40dvh)` (`assistant-overlay.tsx:47`). Long answers and plans scroll
  inside a small box at the bottom of a dashboard.
- The TrueForge view has an error boundary with "Reload Chat" (`components/chat/chat-error-boundary.tsx:40-69`). Its
  copy, "Your workspace data is completely safe", is a promise the boundary cannot check.

**Rendering gaps (native).**

- No markdown, so lists, tables, links and code from the model appear as raw text (`assistant-overlay.tsx:70`).
- Tool events keep only a label. The tool result payload is dropped (`lib/api/ask-ai.ts:147-151`), so there are no
  result cards (an email sent, a calendar event created, a sheet link).
- The approval UI lists tool names only (`assistant-overlay.tsx:85`). `ToolApproval` carries `threadId`, `toolCallId`
  and `toolName` (`lib/api/ask-ai.ts:122-127`). The user approves a `gmail_send` without seeing recipient, subject or
  body. They also do not see the risk class that `chat-coverage.md` lists for every tool.
- Plan steps show a description and state, with no per-step risk and no tool name (`components/home/plan-card.tsx:169-212`).
  Step toggles use native checkboxes instead of the `Checkbox` primitive (`:172-177`).
- There are no citations from brain memory (`gap26sept/00-workspace-connectivity.md:111-113`).
- The TrueForge view shows rich tool cards, but none of them are tied to Darex approvals, audit or plan history.

**Mode selector.** `AskModePicker` uses `SelectPill` for Auto / Pick one / Team. Team is capped at three, with a status
note (`ask-mode-picker.tsx:6-55`). It is hidden in demo mode (`home-chat.tsx:115`) and absent from the default
TrueForge view. Gaps:

- There is no "why this employee" display for Auto. `handledBy` is shown as plain text (`assistant-overlay.tsx:69`).
- There is no `@Name` autocomplete in the input.

**Attachments and voice.**

- The `+` button picks a file, validates its extension and shows a chip. `submit()` calls `onSend(text)` and clears
  the attachment, so the file is never uploaded or referenced (`components/ui/chat-bar.tsx:72-77,90-97`).
- The mic button waits `TIMINGS.micListeningMs`, then appends "Summarize my business" to the input
  (`chat-bar.tsx:15,59-68`).
- Both controls appear in live mode, in every place `ChatBar` is used:
  - Home (`home-chat.tsx:121`)
  - Actions command bar (`components/actions/command-bar.tsx:51`)
  - Create Employee panel (`components/ai-employees/create-panel.tsx:136`)
  - Conversations workspace and thread reply (`components/conversations/workspace-panel.tsx:61`, `thread-panel.tsx:258`)
  - Workspace ready (`components/onboarding/workspace-ready.tsx:74`)

**Accessibility.**

- The message list is `role="log"` with `aria-live="polite"` (`assistant-overlay.tsx:60`). Votes have labels and
  `aria-pressed` (`:117-125`).
- Every streaming chunk re-renders the live region. Screen readers may announce partial text repeatedly. Announce
  only completed messages.

**Security note.** This is not a frontend file, but it shapes the UX. The TrueForge proxy catches the session lookup
failure and proxies anyway without tenant headers ("Unauthenticated or in demo mode",
`apps/dashboard/app/api/trueforge/[...path]/route.ts:69-72`). It also copies every incoming header, cookies included,
to the sidecar (`:74-79`). Both should be reviewed by whoever owns that route.

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| CHAT-01 | P0 | The default chat bypasses Ask AI: no mode selector, no plan confirm, no Darex approvals or history; the backend always picks the Executive | `home-screen.tsx:31-33,113-121`, `trueforge-chat.tsx:134-137`, `route.ts:54` | Make the native client the full-height Home view. Keep TrueForge only if it is driven by the same `/api/ask-ai` contract, or as an internal tool. See the vision doc, sections 3 and 4. | L |
| CHAT-02 | P1 | Native chat is squeezed into a 24rem overlay under a dashboard | `assistant-overlay.tsx:47` | Full-height conversation layout with a sticky composer (vision doc, section 4). | M |
| CHAT-03 | P1 | No markdown and no tool-result cards; tool payloads dropped | `assistant-overlay.tsx:70-71`, `lib/api/ask-ai.ts:147-151` | Keep `evt.result` / `evt.output` on the message, render cards per tool family (vision doc, section 5), and add a safe markdown renderer. | L |
| CHAT-04 | P0 | Tool approval shows only tool names, with no arguments, risk or expiry | `assistant-overlay.tsx:83-95`, `lib/api/ask-ai.ts:122-127` | Extend the `approval` event with `args` (redacted), `risk` and `expiresAt`. Render an approval card with the full preview, "Edit" for drafts, Allow / Deny and "Always allow for this employee" (writes an autonomy rule). | M (+ backend field) |
| CHAT-05 | P0 | Attach button drops the file silently | `chat-bar.tsx:72-77,90-97` | Hide the button until upload exists. Then upload to `POST /api/brain {action:"upload"}` or a chat attachment endpoint and send the reference. | S to hide, L to build |
| CHAT-06 | P0 | Mic types a hardcoded sentence | `chat-bar.tsx:15,59-68` | Hide in live mode. Build real dictation with the Web Speech API, or server STT (vision doc, section 8). | S to hide, M to build |
| CHAT-07 | P2 | No Stop for streaming replies; 2,000-character input truncated silently | `chat.ts:30,69,112-155` | Add an `AbortController` and a Stop button. Show a counter near the limit and refuse instead of truncating. | S |
| CHAT-08 | P2 | Live region announces every chunk | `assistant-overlay.tsx:60` | Mark the streaming bubble `aria-busy` and announce on `done`. | S |
| CHAT-09 | P2 | Auto mode does not show why an employee was chosen; no `@Name` autocomplete | `assistant-overlay.tsx:69`, `ask-mode-picker.tsx` | Show a "Routed to Emma: matches 'refund' (Customer Support)" chip from the router reason, and add an `@` mention menu in the composer. | M |
| CHAT-10 | P2 | Plan steps show no tool or risk; native checkboxes | `plan-card.tsx:169-212` | Add a tool chip and risk badge per step, and use the `Checkbox` primitive. | S |
| CHAT-11 | P1 | TrueForge proxy proxies unauthenticated requests and forwards cookies | `apps/dashboard/app/api/trueforge/[...path]/route.ts:69-79` | Return 401 when there is no session, and strip `cookie` and `authorization` before forwarding. Security-sensitive: flag to the backend owner. | S |
| CHAT-12 | P2 | The error boundary promises "data is completely safe" | `chat-error-boundary.tsx:57` | Plain copy: "The chat stopped. Reload to continue; your conversation is saved." | S |

### 3.6 AI Employees (`/ai-employees`)

**What it shows.**

- A header with a search pill (`components/ai-employees/employees-view.tsx:24-36`).
- A live workforce strip with active count, conversations handled, resolved and average resolution
  (`employee-stats.tsx:9-27`).
- A grid of employee cards (`employee-card.tsx:29-53`). Each card has:
  - the name, linked to its Conversations workspace;
  - the role;
  - the stats grid;
  - "Open Workspace";
  - in live mode, Details, Pause/Resume and Remove (`employee-actions.tsx:13-60`).
- Details opens a drawer with a performance card and these tabs (`employee-drawer.tsx:15-48`):
  - Activity, with "explain" per activity;
  - Growth, for sales-like roles only, by regex (`:25`);
  - Skills;
  - Packs;
  - Tools (allowlist);
  - Settings (rename, change role, archive with reassign).
- The rail shows a "Create Employee" plus while on this page (`icon-rail.tsx:86-88`). It opens a scripted
  create-employee chat (`create-panel.tsx`, `create-flow.ts`).

**APIs.**

- `GET/POST /api/employees`, `PATCH/DELETE /api/employees/[id]` (`lib/state/employees.ts:93-120`)
- `GET /api/employees/stats` (`lib/api/employee-details.ts`)
- activity, metrics, allowlist (`fetchAllowlist` / `saveAllowlist`), skills (`lib/api/skills.ts`), packs
  (`lib/api/packs.ts`), tools catalog (`lib/api/agent.ts`), explanation (`fetchExplanation`)

**Real or mock.**

- Lists and drawers are live.
- **Card stats in live mode are only "Tools enabled: n"** (`lib/api/employees.ts:77`). Each card shows a one-cell
  grid, while the per-employee metrics endpoint is used only inside the drawer.
- **The create panel is a scripted form dressed as chat:**
  - three fixed role cards and eight fixed "handles" (`create-flow.ts:1-21`);
  - a keyword guess for free text (`:25-30`);
  - a fixed "suggested integrations" map (`:32-46`);
  - **the name is picked from a pool of seven names, and the user cannot choose it** (`:48-53`);
  - an artificial delay of `TIMINGS.employeeSendMs` before the real POST (`create-panel.tsx:75`);
  - a mic that types "I need someone to answer customer questions" (`:23,140`).
  - Hire sends name, role and handles (`lib/state/employees.ts:93-100`). The roster templates from the blueprint
    (Growth, Customer, Operations, Executive, Finance, Research and others) are not offered.
- **Packs tab is org-wide, not per employee.** `PacksPanel` takes no employee id (`employee-drawer.tsx:43`).
- **Status vocabulary.** The backend's `active` maps to "Working" and everything else to "Training"
  (`lib/api/employees.ts:66-73`). "Pause" therefore shows the employee as "Training" (`employee-actions.tsx:40,43`).

**States.**

- Loading renders nothing (`employees-view.tsx:38`).
- Error and empty states use `EmptyState` (`:38-56`).
- The stats strip hides itself on error or loading with no message (`employee-stats.tsx:11`).

**Realtime.** None. The roster and stats do not react to `work_item_updated`. The backend does not publish roster
changes yet (`gap26sept/00-workspace-connectivity.md:320`).

**RBAC.** None. Pause, Remove, allowlist edits, skills and packs are shown to every role. The backend gates archive
with `canDisableEmployee` (`gap26sept/employees.md:20-26`), so members only learn of the refusal through a toast.

**Mobile.** Cards are one column below `md` (`employees-view.tsx:57`). The drawer is full width on phones
(`employee-drawer.tsx:36`).

**Accessibility.**

- Remove uses `window.confirm` (`employee-actions.tsx:50`, `employee-settings.tsx:38`). It is unstyled, and some
  embedded browsers block it.
- Buttons carry sr-only names that include the employee name (`employee-actions.tsx:34,44,57`). That is good.

**Missing actions.**

- No "Chat with this employee" button, even though Pick one mode exists. This is the most natural way to reach
  an employee.
- No autonomy summary per employee. The rules live in Settings > AI Workforce, grouped by action type, not by
  employee (see [3.15](#315-settings)).
- No persona, tone or working-hours editor. `gap26sept/employees.md:107-110` lists these as open.

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| EMP-01 | P1 | Card stats are a single "Tools enabled" cell in live mode | `lib/api/employees.ts:77`, `employee-card.tsx:30-43` | Show per-employee metrics: conversations, completion rate, average resolution, pending approvals, from `/api/employees/[id]/metrics` or a batched stats call. | M |
| EMP-02 | P1 | The create flow is scripted; name is auto-picked; blueprint roles absent; fake delay; fake mic | `create-flow.ts:1-53`, `create-panel.tsx:23,75,140` | Replace with a real hire flow: role templates from the backend roster, an editable name, tools from the catalog, persona and autonomy defaults. Best done as a chat flow (vision doc, section 9.3). Remove the sleep. | L |
| EMP-03 | P1 | No "Chat with" entry point | `employee-card.tsx` | Add "Ask {name}", which opens Home chat with Pick one set to this employee (`setMode("single",[id])`, `lib/state/chat.ts:394-398`). | S |
| EMP-04 | P2 | "Pause" shows "Training" | `lib/api/employees.ts:66-73`, `employee-actions.tsx:40-43` | Add a "Paused" status to the `Employee` type and map it 1:1 from the backend. | S |
| EMP-05 | P2 | Packs tab is org-wide inside a per-employee drawer | `employee-drawer.tsx:43` | Move packs to Settings > AI Workforce, or filter by the employee's role. | S |
| EMP-06 | P2 | No role gating on Pause, Remove, Tools, Skills | `employee-actions.tsx`, `tools-panel.tsx` | Gate on session role (X-RBAC-01). Show read-only views to members. | S after X-RBAC-01 |
| EMP-07 | P2 | `window.confirm` for archive | `employee-actions.tsx:50`, `employee-settings.tsx:38` | Use `ConfirmDialog` with a danger variant. Show the reassign picker in the same dialog. | S |
| EMP-08 | P2 | Blank page while loading; stats strip vanishes on error | `employees-view.tsx:38`, `employee-stats.tsx:11` | Add skeleton cards and an inline error with Retry. | S |
| EMP-09 | P2 | No persona, tone, hours or per-employee autonomy editors | `gap26sept/employees.md:78-79,107-110` | Add an "Autonomy" tab that lists this employee's rules from `/api/settings/autonomy` filtered by role. Add persona and tone fields once the backend stores them. | M (+ backend) |

### 3.7 Conversations (`/conversations`)

**What it shows.** The page is employee-first (`components/conversations/conversations-view.tsx:75-147`). Each level is
reflected in the URL as `?employee=` or `?thread=`, and Escape steps back one level (`:42-71`).

1. **Employee list on the left** (`employee-list.tsx`), plus a bell popover (`bell-popover.tsx`).
2. **Overview on the right** (`overview-panel.tsx`). Its stats and recent rows show only in demo mode (`:44-63`); in
   live mode it shows attention rows built from approvals and waiting threads (`workspace-data.ts:38-60`).
3. **Employee selected: a "Workspace"** (`workspace-panel.tsx`). It holds the stats, an "Ask {name}…" bar, a
   New conversation button, Needs Attention, Open promises (`open-loops.tsx`) and the three most recent threads
   (`RECENT_LIMIT = 3`, `:22`).
4. **Thread selected: the thread panel** (`thread-panel.tsx`). It holds:
   - a header chip, "You're handling this" or "Handled by X";
   - a Resolved chip;
   - presence ("A, B viewing / typing");
   - employee reassign and teammate assign selects;
   - Resolve / Reopen and Take over / Hand back buttons;
   - the message log with "Load older";
   - composer extras for internal notes and link attachments;
   - the chat bar (`:170-264`).

There are also a customer search dialog and a message search dialog (`search-dialog.tsx`), and "Load more" for
threads (`load-more-threads.tsx`).

**APIs.**

- `GET /api/conversations` with keyset paging (`lib/state/threads.ts`)
- `GET/POST /api/conversations/[id]/messages` with a `before` cursor
- `PATCH /api/conversations/[id]` for resolve, pause AI, assign employee and assign user
- `POST /api/stream/presence` (`lib/realtime/presence.ts:6-8`)
- customer overview and open loops (`customer-overview.tsx:10`, `open-loops.tsx`)
- new conversation by channel (`new-conversation-dialog.tsx:18-27`)

**Realtime.** This is the best-wired page:

- message and conversation events refresh the list and the open thread (`lib/realtime/events.ts:34-39`);
- the thread polls every 8 s as a safety net, a quarter as often while the stream is up (`thread-panel.tsx:100-109`);
- presence heartbeats every 30 s and sends "typing" throttled to 5 s (`:111-133`).

**Real or mock.**

- Live, apart from demo-only overview stats (`overview-panel.tsx:44-63`).
- `workspace-data.ts:9-11` still reads `WORKSPACE_STATS` mocks for the demo employee ids.
- The Figma attention rows map is still exported (`workspace-data.ts:26-30`). It is used in demo mode only, but ships
  in the bundle.

**Critical behaviour.**

- **The "Ask {employee}…" bar in the Workspace sends the text as a message to the employee's most recent customer
  thread** (`workspace-panel.tsx:39-43`). The placeholder `Ask ${employee.name}…` (`:43`) suggests a private
  instruction to the AI employee. A manager who types "be more formal with this client" sends that sentence to the
  customer.
- When the employee has no threads, sending silently does nothing (`:40`).

**Composer.**

- Two attach mechanisms sit next to each other:
  - the chat bar `+`, which picks a file and drops it (CHAT-05);
  - "Attach link", which really attaches a URL (`thread-composer-extras.tsx:21-53,76-110`).
- The internal-note toggle works: the bubble shows a dashed yellow border and the placeholder changes
  (`thread-panel.tsx:236,259`).
- There are no canned replies, AI-suggested draft, delivery ticks, channel badge per message or "the AI is drafting"
  indicator. `gap26sept/conversations.md:118-129` lists these.

**Information architecture.**

- There is no single inbox. To find "all unassigned WhatsApp threads waiting for a human", a user has to open each
  employee in turn.
- There are no filters for channel, status, SLA breach, assignee or unread. The backend supports status and channel
  filters (`gap26sept/conversations.md:32-36`).
- The Workspace shows only three recent threads, with no "see all".

**States.**

- The page renders `null` until employees load (`conversations-view.tsx:73`). The error is an inline alert (`:85-89`).
- Thread action errors arrive as toasts with the backend message (`thread-panel.tsx:84-91,135-167`). That is good.

**RBAC.** None in the UI. `gap26sept/conversations.md:16` (row 11) says the backend RBAC on reply, pause and resolve is
🟡. Members see every control.

**Mobile.**

- List and detail swap below `md` (`conversations-view.tsx:78,84`), with back buttons (`:102-109`, `thread-panel.tsx:172-179`).
- The thread header wraps two `SelectPill`s and two buttons. On a 390 px phone that is four rows of controls above
  the log.
- `min-h-[32rem]` on the thread panel (`thread-panel.tsx:171`) plus the shell padding pushes the composer below the
  fold on short phones.

**Accessibility.**

- The log is `role="log"` and labelled (`thread-panel.tsx:213-218`). Presence is a `role="status"` chip (`:186-189`).
- The internal-note label is duplicated: the toggle has a label, and a visible span is marked `aria-hidden`
  (`thread-composer-extras.tsx:81-82`). This works but is fragile.
- Customer and AI bubbles differ only by background colour and alignment. The sender label text helps (`:224-226`).

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| CONV-00 | P0 | "Ask {employee}…" sends the text to a customer | `workspace-panel.tsx:39-43` | Either route the bar to Ask AI with Pick one set to this employee, which is the vision, or relabel it "Reply in latest conversation with {customer}" and show the recipient. Never send to a customer from a bar labelled "Ask". | S |
| CONV-01 | P1 | Employee-first navigation; no unified inbox, filters or SLA view | `conversations-view.tsx:75-147`, `workspace-panel.tsx:22` | Add an "All conversations" list as the default. Filter by channel, status (open, needs human, resolved), assignee (me, unassigned, employee), SLA breached and unread, and keep the filters in the URL. Keep the employee filter as one facet. | L |
| CONV-02 | P1 | Composer lacks AI draft, canned replies, delivery state and channel badge | `thread-panel.tsx:221-263` | Add "Draft with {employee}" (Ask AI with the thread context, returning a draft into the composer), `/` canned replies, per-message channel icon and status ticks once the backend sends them. | L |
| CONV-03 | P2 | Two attach mechanisms, one fake | `chat-bar.tsx:90-97`, `thread-composer-extras.tsx` | Hide the `+` (CHAT-05) and keep "Attach link" until real upload exists. | S |
| CONV-04 | P2 | Header control overload on mobile; composer below the fold | `thread-panel.tsx:171,191-209` | Collapse assign, resolve and takeover into an overflow menu below `md`. Use `100dvh` minus the header for the thread. | M |
| CONV-05 | P2 | No role gating on takeover, resolve and reassign | `thread-panel.tsx:191-209` | Gate on session role once X-RBAC-01 lands. | S |
| CONV-06 | P2 | Blank render while loading | `conversations-view.tsx:73` | Skeleton list and panel. | S |
| CONV-07 | P2 | No customer context side panel (CRM, open deals, previous threads) | `gap26sept/conversations.md:126-127` | A collapsible right panel in the thread with the customer overview, open loops and linked inquiries or opportunities. | M |
| CONV-08 | P3 | Demo mocks and Figma maps ship in the live bundle | `workspace-data.ts:3,9-11,26-30`, `overview-panel.tsx:13` | Move them behind dynamic imports gated on `isDemo`. | S |

### 3.8 Actions (`/actions`)

**What it shows.**

- A Filter menu that blurs the page behind it (`components/actions/actions-view.tsx:96-103`) and a page header.
- **Needs Your Attention**: a horizontal strip of attention cards (`:112-148`, `attention-card.tsx`).
- **Command bar area**:
  - templates (`templates-section.tsx`, `templates.ts`);
  - in live mode, a tabbed panel with Morning Brief and Tasks, capped at `max-h-32` (8 rem) with inner scroll (`:150-160`);
  - a sticky chat bar with placeholder "Call all warm leads from yesterday." (`command-bar.tsx:47-52`).
- **Recent Activity** in a side column (`recent-activity.tsx`).
- **Work item drawer** with details, assignee and priority selects, and event history (`work-item-drawer.tsx`).
- **Quote dialog** for `kind === "quote"` (`quote-dialog.tsx`).

**APIs.**

- `GET /api/decisions` and `GET /api/work-items`, merged into one approvals list (`lib/api/actions.ts:140-156`)
- `PATCH /api/decisions` or `POST /api/work-items/[id]/decision` (`:169-180`)
- `GET /api/brief`, `POST /api/brief/[id]/triage` (`lib/api/work.ts:81-92`)
- `GET/POST/PATCH /api/work-items*` and sweeps (`:152-197`)

**Real or mock.**

- Live, with these exceptions:
  - the employee label falls back to `DEFAULT_ROSTER` mocks when the id is unknown (`actions-view.tsx:18,135-138`);
  - templates are a fixed list (`templates.ts`).
- The command bar hands the text to Ask AI and navigates to `/home` (`command-bar.tsx:30-36`). There it lands on the
  TrueForge view and not the native chat that received it (see ONB-01 and CHAT-01). In live mode, the command
  therefore disappears from the user's view.

**Approvals.**

- **Non-quote cards have Approve only: no Reject, no Snooze, no Modify** (`attention-card.tsx:52-60`).
  - The slice supports `sendBack` (`lib/state/approvals.ts:57-59`).
  - The backend supports reject, snooze and modify (`gap26sept/work-items.md:40-44`).
  - The only rejection paths are the quote dialog and the Observability page.
- **The quote amount is not sent.** `onApprove(amount)` calls `approve(quote.id, amount)` (`actions-view.tsx:169-172`).
  In live mode, `resolveLive` ignores the note (`lib/state/approvals.ts:21-36`), and `decideApproval` sends only the
  status (`lib/api/actions.ts:169-180`). The toast still says "Quote approved at {amount}". The backend approves the
  employee's original figure.
- **Success toast before the server answers.** `approveCard` toasts "Approved: …" after a 250 ms fade, while the
  request is still in flight (`actions-view.tsx:82-91`). If the backend refuses, the card comes back with an error
  toast, so the user sees two contradictory toasts.
- "Recorded. N more approval needed before it runs." is sent through `reportError` (`lib/state/approvals.ts:25-28`).
  A success-with-caveat is shown in the error channel.
- There is no preview of what will be sent, no risk level and no expiry countdown. The backend returns
  `expiresAt` (`gap26sept/autonomy.md:136-139`).
- There are no bulk actions ("Approve all low-risk").

**Morning Brief and Tasks.**

- Each brief row has three triage actions (`brief-row.tsx`).
- The 8 rem panel shows about two rows before scrolling (`actions-view.tsx:155`).
- New task dialog: `new-task-dialog.tsx`.

**States.**

- The attention strip renders `null` while loading (`actions-view.tsx:116`).
- Empty copy depends on the filter (`filter-actions.ts`).
- Live write errors reach toasts through `useLiveErrorToasts` (`:52`).

**Realtime.** Approvals, work and activity refresh on stream events (`lib/realtime/events.ts:40-45`).

**RBAC.** None in the UI. The backend blocks auditors from deciding (`gap26sept/work-items.md:18`).

**Mobile.** Cards are a horizontal snap strip at `w-72` (`actions-view.tsx:131`). The command bar sticks above the
safe area (`command-bar.tsx:49`).

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| ACT-01 | P0 | No Reject on non-quote approval cards | `attention-card.tsx:52-60` | Add Reject (with an optional reason), Snooze and "Edit and approve" where the backend supports `modify`. Use one `ApprovalCard` component everywhere (Actions, Observability, chat, Home). | M |
| ACT-02 | P0 | Edited quote amount is not sent; toast claims it was | `actions-view.tsx:169-172`, `lib/state/approvals.ts:21-36`, `lib/api/actions.ts:169-180` | Send `modifiedArgs` (`{amount}`) with action `modify` for work items; the backend propagates `modifiedArgs` (`gap26sept/work-items.md` tracker #1). Until then, disable editing in live mode. | S to M |
| ACT-03 | P1 | Optimistic "Approved" toast before the server answers | `actions-view.tsx:82-91` | Toast on resolve, and show a pending state on the card. | S |
| ACT-04 | P1 | Command bar sends to Ask AI then navigates to a view that does not show it | `command-bar.tsx:30-36` | After CHAT-01, navigate to the chat with the conversation open, or show the reply inline in a side sheet. | S after CHAT-01 |
| ACT-05 | P2 | Approval cards lack preview, risk, expiry and bulk actions | `attention-card.tsx`, `lib/api/actions.ts:60-110` | Map `payload`, `risk` and `expiresAt` into `Approval`. Render a preview and countdown. Add multi-select with "Approve low-risk". | M |
| ACT-06 | P2 | Brief and Tasks squeezed into 8 rem | `actions-view.tsx:155` | Give Brief and Tasks their own full-height column or tab. | S |
| ACT-07 | P2 | Partial approval reported as an error | `lib/state/approvals.ts:25-28` | Add an `info` toast channel. | S |
| ACT-08 | P3 | Mock roster used as a label fallback | `actions-view.tsx:18,135-138` | Fall back to the backend role label. | S |
| ACT-09 | P2 | The same pending decisions appear in Actions and Observability with different controls | `actions-view.tsx:63`, `observability-view.tsx:31` | Decide on one approvals home (Actions, plus the chat inbox; vision doc section 7). Observability links to it. | S |

### 3.9 Opportunities: Pipeline tab

**What it shows.**

- A header with Filter (a dialog) and Sort (a menu) (`components/opportunities/opportunities-view.tsx:89-118`).
- Tabs for Pipeline, Listings, Showings, Inquiries and Rent (`components/real-estate/real-estate-tabs.tsx:10-16`).
- On Pipeline:
  - KPI cards (`opportunity-kpis.tsx`);
  - Hot / Warm / Ghosted groups of rows (`opportunity-groups.tsx`, `opportunity-row.tsx`);
  - row actions that open dialogs: Call, Nudge, Follow-up calendar, Case study (`opportunity-action-dialog.tsx`).

**APIs.** `fetchOpportunities` and `decideOpportunity` (`lib/state/opportunities.ts:1,30-44`). Growth data is in
`lib/api/growth.ts`.

**Real or mock.**

- Rows are live.
- **"Call Now" hardcodes the employee "Sarah"**: "Sarah will call {name} right away", "The call is queued with Sarah"
  (`call-dialog.tsx:17,20`, `opportunity-action-dialog.tsx:13`).
- **Case studies are three hardcoded samples** (`case-studies.ts:1-6`). The selected title is sent as the approval note
  (`lib/state/opportunities.ts:34`).
- **"Schedule follow-up" ignores the chosen date in live mode.** It is sent as `snooze` with no note
  (`lib/state/opportunities.ts:33-34`), while the dialog offers a full calendar (`follow-up-calendar.tsx`).
- Money is formatted as `₹…L` (`opportunity-filters.ts:94`).

**States.** Skeletons, then `EmptyState` (`opportunities-view.tsx:131-140`). Errors reach toasts (`:54`).

**Realtime.** None. The backend's proposed `opportunity_decided` event is not consumed
(`gap26sept/00-workspace-connectivity.md:278`).

**RBAC.** None.

**Vertical fit.** Listings, Showings, Inquiries and Rent are real-estate tools. They are shown to every workspace
regardless of business type (`real-estate-tabs.tsx:10-16`). A bakery sees "Sync from MLS".

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| OPP-01 | P1 | "Call Now" names a hardcoded employee "Sarah" | `call-dialog.tsx:17,20`, `opportunity-action-dialog.tsx:13` | Use the opportunity's assigned employee, or the Growth or Sales employee from the roster. | S |
| OPP-02 | P1 | Follow-up date picked in the dialog is discarded | `lib/state/opportunities.ts:33-34` | Send `snoozeUntil` (ISO) with the snooze action, or create a work item with `sla_due_at`. | S (+ check backend field) |
| OPP-03 | P2 | Case studies are fake samples | `case-studies.ts:1-6` | Load from brain items tagged `case_study`, or hide the action until some exist. | M |
| OPP-04 | P2 | Real-estate tabs shown to all verticals | `real-estate-tabs.tsx:10-16` | Show them only when `businessType` is real estate, or a real-estate pack is installed. | S |
| OPP-05 | P2 | No realtime for pipeline changes | `lib/realtime/events.ts:33-49` | Refresh on `work_item_updated` and `opportunity_decided` once published. | S |

### 3.10 Opportunities: Listings, Showings, Inquiries, Rent

**What it shows.** Each tab uses the shared `Panel`: intro, actions, skeleton, error, empty or rows
(`components/real-estate/panel.tsx:17-45`).

| Tab | Contents | Evidence |
|---|---|---|
| Listings | Add, edit and withdraw (with confirm); "Sync from MLS"; "Match to inquiries" | `listings-panel.tsx:22-47`, `listing-dialog.tsx` |
| Showings | Agenda list; book dialog with local timezone; "Turn on calendar sync" with the watch status note | `showings-panel.tsx:21-62`, `showing-dialog.tsx:53` |
| Inquiries | Status advance buttons (New → Contacted → Showing → Closed), mark lost, create and edit dialog | `inquiries-panel.tsx:17-72` |
| Rent | Leases and charges; reminder with confirm. The copy says a reminder never marks a charge paid. | `rent-panel.tsx:21-75`, `rent-dialogs.tsx` |

**APIs.** `/api/listings*`, `/api/showings*`, `/api/showings/calendar-watch`, `/api/inquiries*` and the rent endpoints,
through `lib/state/{listings,showings,inquiries,rent}.ts`.

**Real or mock.** Live. The copy is honest; Listings says "Darex only shows what you add or sync, it never invents a
listing" (`listings-panel.tsx:37`).

**States.** These are the most consistent in the app (`panel.tsx:25-42`).

**Gaps.**

- **"Sync from MLS" is always offered**, but the backend returns 501 (no MLS client;
  `docs/BACKEND-WIRING.md:49`, `gap26sept/listings.md:9`). The user learns this from a toast after a click
  (`listings-panel.tsx:24-47`).
- Inquiries use advance buttons, not drag-and-drop columns. There is no assignee or round-robin, and no activity
  timeline (`gap26sept/inquiries.md:68,106-115`).
- Showings are an agenda list only, with no week view, post-showing feedback or reschedule link
  (`gap26sept/showings.md:92-106`).
- Listings have no photo upload, map or RERA badge (`gap26sept/listings.md:82-107`).
- No realtime for `inquiry_updated`, `inquiry_deleted` or `listing_updated`, although the backend publishes them
  (`gap26sept/00-workspace-connectivity.md:320`, `gap26sept/inquiries.md:14`).
- A local `confirm-dialog.tsx` and `field.tsx` duplicate the Settings `ConfirmDialog` and the input styles
  (`components/real-estate/confirm-dialog.tsx`, `components/settings/confirm-dialog.tsx`).

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| RE-01 | P2 | "Sync from MLS" offered while the backend returns 501 | `listings-panel.tsx:45-47` | Hide it, or disable it with "No MLS provider connected", until a provider exists. | S |
| RE-02 | P2 | No realtime for inquiries and listings | `lib/realtime/events.ts:33-49` | Add `inquiry_updated`, `inquiry_deleted` and `listing_updated` to `refreshesFor` with new refresh targets. | S |
| RE-03 | P2 | Inquiry pipeline lacks assignee, timeline and board view | `inquiries-panel.tsx` | Add an assignee select (members or employees), a drawer with linked conversation and showings, and an optional board view. | L |
| RE-04 | P3 | Duplicate confirm dialog and field primitives | `real-estate/confirm-dialog.tsx`, `real-estate/field.tsx` | Promote a `ConfirmDialog` and `TextField` to `components/ui`. | S |

### 3.11 Insights (`/insights`)

**What it shows.**

- An `h1`, then a sub-nav for Insights, Observability and Plans (`app/(app)/insights/page.tsx:13-21`,
  `components/insights/insight-subnav.tsx`).
- Category tabs: All, Critical, Growth, Customer, Performance, Positive.
- Four KPI cards (`insight-kpis.tsx:19-48`).
- Grouped insight rows with a "Review Action" dialog (`insight-dialog.tsx`).
- In live mode, a Performance section with a range menu, CSV export and cards for channels, hours by role and others
  (`performance-section.tsx`, `performance-cards.tsx`, `mini-charts.tsx`).

**APIs.** The insights loader with `startInsightAction(metricId)` (`lib/state/insights.ts:36-73`), the pipeline value,
and `/api/analytics*` with export (`lib/state/analytics.ts`, `lib/api/analytics.ts`).

**Real or mock.**

- **Two of the four KPIs are permanently "-" in live mode** ("Business Health", "AI Efficiency";
  `lib/state/insights.ts:80-87`). In demo mode they read 89/100 and 96% (`mocks/insights.ts:13-18`).
- The KPI component defaults to the mock numbers when no prop is passed (`insight-kpis.tsx:7,19`).
- **"Approve" toasts "Approved. It's now running in Actions." unconditionally** (`insights-view.tsx:54-58`). Two cases
  contradict it:
  - when the insight has no action, the slice reports "There is no action to run for this insight yet." as an error
    (`lib/state/insights.ts:60-63`);
  - when the start fails, the slice rolls back.
  The user sees a success toast and an error toast together.
- **Dismiss is local only.** Dismissed ids go to `localStorage` (`lib/state/insights.ts:12-25,54-57`). Teammates and
  other devices still see the insight.
- **The export button is labelled "Export 7-day CSV"** whatever range is selected, and the request does not pass the
  range (`performance-section.tsx:19-28,42-43`).

**Charts and accessibility.**

- SVG charts have `role="img"` with a summary label (`mini-charts.tsx:16,40`).
- Bars are `aria-hidden`, with the numbers given in text (`:58`).

**States.** Skeleton and `EmptyState` (`insights-view.tsx:74-83`).

**Realtime.** None. The backend's `useLiveRefresh` equivalents (`gap26sept/00-workspace-connectivity.md:320`) are not
consumed.

**Gap-doc items not surfaced.**

- The analytics API returns `gaps` (explanations for disconnected connectors). They are not rendered
  (`gap26sept/analytics.md:69-71`).
- The CSAT proxy label is not shown (`:30,66-68`).
- There is no P50/P90 latency (`:75-77`).

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| INS-01 | P1 | Success toast shown even when nothing runs | `insights-view.tsx:54-58`, `lib/state/insights.ts:60-71` | Make `resolve` return a promise with the outcome and toast once. Disable "Approve" when `actionable === false`, with the reason. | S |
| INS-02 | P2 | Two KPI tiles always "-" | `lib/state/insights.ts:80-87` | Replace them with real numbers that exist: automation rate (`queryAutomationRate`) and pending approvals. Remove a tile rather than show a permanent dash. | S |
| INS-03 | P2 | Dismiss is per browser | `lib/state/insights.ts:12-25` | Persist dismissals server-side (an `insight_dismissals` table or org preference). | M (+ backend) |
| INS-04 | P2 | Export label and range mismatch | `performance-section.tsx:19-43` | Pass `range` to `downloadAnalyticsCsv` and label "Export CSV ({range})". | S |
| INS-05 | P2 | Analytics `gaps`, CSAT proxy flag and latency percentiles not rendered | `gap26sept/analytics.md:30,69-77` | Add a "Why some numbers are missing" card from `gaps`, a "proxy" badge on CSAT, and P50/P90 in the latency card. | M |
| INS-06 | P3 | KPI component defaults to mock numbers | `insight-kpis.tsx:7,19` | Make `kpis` required. | S |

### 3.12 Observability (`/insights/observability`)

**What it shows.** The page is titled "Employee health" (`components/observability/observability-view.tsx:37`). It
has:

- health metric cards with an alert summary ("Zero is an alert");
- a first observation card;
- rollout weeks with a Backfill button;
- an Explain panel;
- a Pending decisions list with Approve and Reject (`:41-96`).

**APIs.** `/api/observability/*` through `lib/state/observability.ts`, and `/api/decisions` through the approvals slice.

**Real or mock.** Live, with per-part error lines (`:16-22`).

**UX concerns.**

- The page mixes operator tools with tenant content:
  - "Backfill" (`backfill-button.tsx`);
  - "Explain" for an arbitrary object id (`explain-panel.tsx`);
  - rollout stage vocabulary such as "Shadow" and "External, gated".
  These mean little to a business owner.
- Pending decisions duplicate the Actions page. Here they have Reject (`decision-card.tsx`); there they do not (ACT-01).
- The sub-nav groups Observability under "Insights" while the page `h1` says "Employee health". The names do not match.

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| OBS-01 | P2 | Operator tools (backfill, explain by id, rollout stages) shown to tenants | `observability-view.tsx:74-81` | Move them to the platform console, or behind an "Advanced" disclosure for owners. | S |
| OBS-02 | P2 | Duplicate decisions list | `observability-view.tsx:83-96` | Link to Actions filtered by employee decisions. | S |
| OBS-03 | P3 | Sub-nav label and page title differ | `insight-subnav.tsx:7`, `observability-view.tsx:37` | Use "Employee health" in both. | S |

### 3.13 Plans (`/insights/plans`)

**What it shows.** "Open plans" or "Plan history" (toggle), Refresh, and a list of plan items. Each item reuses
`PlanCard`, with a "Run approved plan" button for plans that are approved but not run
(`components/plans/plans-view.tsx:25-75`, `plan-item.tsx:37-61`).

**APIs.** `GET /api/ask-ai/plan` (and `?history=1`), plus the same PATCH, execute, revise and feedback calls as chat
(`lib/state/plans.ts`).

**Real or mock.** Live. The history toggle is persisted to `localStorage` (`lib/state/plans.ts:22`).

**Gaps.**

- No realtime. `plan_updated` refreshes approvals and activity only (`lib/realtime/events.ts:42-43`). Plans need the
  manual Refresh button.
- No filters (status, date, employee), no batch approve, and no compensation view for `completed_with_errors`
  (`gap26sept/plans.md:161-182`).
- Plans are under Insights, not next to chat, so a plan started in chat is hard to find again.
- There is no link from a plan back to the conversation it came from.

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| PLAN-01 | P2 | No live refresh | `lib/realtime/events.ts:42-43` | Add a `plans` refresh target on `plan_updated`. | S |
| PLAN-02 | P2 | No link to the source conversation; no filters | `plan-item.tsx` | Add "Open in chat" (`conversationId`) and status/date filters. | M |
| PLAN-03 | P2 | `completed_with_errors` shows no compensation detail | `gap26sept/plans.md:177-182` | Render `compensation_steps` from the execute stream and history. | M |

### 3.14 Integrations (`/integrations`)

**What it shows.**

- A page header titled "Integration", singular, while the metadata says "Integrations" (`app/(app)/integrations/page.tsx:8,14-19`).
- Four stat tiles, a Nango warning banner, an error line, a card grid, a "Website chat widget" card, and the Connect
  dialog, Manage drawer and Widget drawer (`components/integrations/integrations-view.tsx:77-146`).
- A filter in `?filter=`, and a `?connect=<id>` deep link that opens the Connect dialog once (`:46-61`).

**APIs.**

- `GET /api/integrations` (`lib/api/integrations.ts:109-111`)
- OAuth: `GET/POST /api/integrations/nango-token`, then the Nango popup (`:144-170`)
- BYOK: `POST /api/integrations/razorpay|whatsapp` (`:173-183`)
- disconnect: `POST /api/integrations` (`:120-125`)
- test: `POST /api/integrations/test` (`:127-130`)
- ping: `POST /api/integrations/:id/ping` (`:206-208`)
- WhatsApp numbers and auto-reply (`lib/api/whatsapp.ts:41-47,123-134`)
- widget key: `/api/settings` (`lib/api/widget.ts:37-49`)

**Real or mock.**

- "AI Employees Connected" is `min(connected, employees)`, an invented number (`integration-filters.ts:54-62`).
- "Sync Status" reads "Live" whenever anything is connected (`integration-stats.tsx:48`).
- "Data Health" reads "Not measured yet" in live mode (`:12-15`).
- "What will be shared" is a hardcoded list per category, not real provider scopes (`connect-dialog.tsx:62-69`,
  `integration-permissions.ts:4-10`).
- "Sync now" runs a connection test, then stamps `lastSync` with the client clock (`lib/state/integrations.ts:133-136`).

**States.**

- **A failed load looks like "nothing connected".** The slice keeps the mock tiles, all with `connected:false`, and
  the page shows an alert above a full grid of Connect buttons (`lib/state/integrations.ts:50-52`,
  `integrations-view.tsx:85-115`).
- Loading shows two skeletons only (`:90-94`).
- Widget key rotation errors are swallowed. The page never mounts `useLiveErrorToasts` (`lib/state/widget.ts:39-41`,
  `widget-drawer.tsx:26-34`).

**Operator copy shown to end users.** "Nango public key is not configured. Set NEXT_PUBLIC_NANGO_PUBLIC_KEY on the
backend" and an "Open Nango" link (`integrations-view.tsx:79-84`, `connect-dialog.tsx:85-91`).

**Connect flow UX.**

- The popup flow is good:
  - Allow is disabled for "Needs setup" tools (`connect-dialog.tsx:109`);
  - double clicks are de-duplicated (`lib/state/integrations.ts:78-84`);
  - Escape and backdrop are ignored while connecting (`connect-dialog.tsx:121-137`).
- Errors are raw Nango SDK text, with nothing specific for a blocked popup (`:48-50,95-99`).
- There is no help text for where to find Razorpay or WhatsApp keys (`:70-81`).
- The Nango host falls back to `http://localhost:3003` (`lib/api/integrations.ts:152`).
- Health is manual ("Check connection"). On failure it says "Disconnect and connect again", with no Reconnect button
  (`connection-health.tsx:76-89`).
- WhatsApp numbers can be removed but not paired. Embedded signup and QR are not wired (`lib/api/whatsapp.ts:3-5`).

**RBAC.** None: Connect, Disconnect, Sync, key rotation, number removal and auto-reply edits are open to every role.

**Reuse for chat.** `ConnectDialog` takes `integration`, `connect`, `onConnected` and `onClose`, with no page coupling
(`connect-dialog.tsx:13-20`). That makes it the right building block for an in-chat connect card (vision doc,
section 6). Chat today only maps the `connectors_status` tool to a status label (`lib/api/ask-ai.ts:73`).

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| INT-01 | P1 | Load failure renders a full grid of "Connect" | `lib/state/integrations.ts:50-52`, `integrations-view.tsx:85-115` | On error, show the error state with Retry and no grid. | S |
| INT-02 | P1 | No RBAC on connect, disconnect, rotate or WhatsApp edits | `integration-card.tsx:41-52`, `whatsapp-panel.tsx`, `widget-drawer.tsx` | Gate on role (X-RBAC-01). Members get "Ask an admin to connect" with a one-click request (chat or notification). | S after X-RBAC-01 |
| INT-03 | P1 | Invented stats ("AI Employees Connected", "Live", "Data Health") | `integration-filters.ts:54-62`, `integration-stats.tsx:12-48` | Show connected count, needs-attention count (revoked or failed ping) and the last successful sync from the backend. Drop the others. | S |
| INT-04 | P2 | Health is manual; no Reconnect | `connection-health.tsx:76-89` | Ping on drawer open, show a persistent health badge on cards (needs backend columns, `gap26sept/connectors.md:169-172`), and add a Reconnect button that reruns `oauthConnect`. | M |
| INT-05 | P2 | Operator copy and Nango links visible to tenants | `integrations-view.tsx:79-84`, `connect-dialog.tsx:85-91` | Show "This app is not available yet" to tenants; keep the technical message for the platform console. | S |
| INT-06 | P2 | Raw popup errors; no key help | `connect-dialog.tsx:48-50,70-81` | Map popup-blocked and closed-by-user errors to plain copy with a retry, and add a "Where do I find this?" link per BYOK field. | S |
| INT-07 | P2 | "Sync now" overstates and uses the client clock | `lib/state/integrations.ts:133-136`, `manage-drawer.tsx:93-95` | Rename to "Test connection" and show the server's last sync. | S |
| INT-08 | P2 | Widget rotation errors swallowed | `lib/state/widget.ts:39-41` | Mount `useLiveErrorToasts` in `IntegrationsView`, or better, mount one global error toast bridge in `AppShell`. | S |
| INT-09 | P3 | "Integration" vs "Integrations"; `h3` cards with no `h2` | `integrations/page.tsx:14`, `integration-card.tsx:29` | Fix the title and heading levels. | S |
| INT-10 | P2 | Localhost Nango fallback | `lib/api/integrations.ts:152` | Refuse with a clear error when no host is configured in production. | S |

### 3.15 Settings

**Shell.**

- `h1` "Settings" and seven tabs following the WAI-ARIA tab pattern, using `router.replace`
  (`components/settings/settings-shell.tsx:14-40`).
- A global error banner joins failures from six loaders. A brain failure therefore shows on the Profile tab
  (`settings-shell.tsx:41-45`, `lib/state/settings.ts:48-89`).
- Every tab waits for six calls (`Promise.allSettled`, `lib/state/settings.ts:50`).
- On phones the tab strip scrolls sideways with no affordance (`components/ui/tabs.tsx:52,70`).

**The core problem: most fields are local only.**

- Only `business.name` reaches the backend (`lib/state/settings.ts:115`).
- Everything else is written to `localStorage` key `settings-live`, behind a "Saved on this device" toast
  (`components/settings/use-save-setting.ts:36`). That covers:
  - Profile name, email, phone, role, time zone and avatar;
  - every Business field except the name;
  - all eight AI Workforce cards;
  - every Notification toggle.
- The live defaults for Workforce and Notifications are the demo values, because `LIVE_SETTINGS` spreads `SETTINGS`
  (`lib/api/settings.ts:11-12`).

**Per tab.**

| Tab | Real backend parts | Local or fake parts | Notable issues |
|---|---|---|---|
| Profile | Email read from session | All fields, avatar (file name only) | Email is editable but not saved, and editing it breaks the "(you)" check in Team (`team-card.tsx:91,108`). Time zones hardcoded to five values (`mocks/settings.ts:14`). Two controls named "Add a profile picture" (`avatar-picker.tsx:70,77-79`). |
| Business | Name (`POST /api/settings update_org`); Knowledge library (`/api/brain*`, gated by `canMutate`); Schedule (`/api/onboarding/settings`, gated); Team (`/api/settings`, members, invites, gated); Workspaces (`/api/org/memberships`, `/switch`, `/workspaces`) | Overview, Ideal Customer, Goals, AI Operating Rules | "Working Hours" in AI Operating Rules duplicates the real Schedule card. Knowledge search mode shown as raw "hybrid" with developer tooltips (`knowledge-library.tsx:136-148`). Workspace switcher hidden silently on error (`workspace-switcher-card.tsx:20`). |
| AI Workforce | Kill switch and rollout (`/api/org/kill-switch`, `/api/org/rollout`, gated); Autonomy rules (`/api/settings/autonomy`); Learned preferences (`/api/settings/suppressions`) | Default Behaviour, Memory, Approval Rules, Communication, Escalation, Collaboration, Permissions, Safety | Real and fake controls side by side: "Permissions > Send Emails" does nothing. Kill switch copy points at the fake rules (`kill-switch-card.tsx:32`). No confirm on "Pause all AI employees" (`:25-30`). Autonomy has no RBAC in the UI and label-in-name mismatches (`autonomy-fields.tsx:16-24,51-55`). Raw `patternKey` shown (`learned-preferences.tsx:50-51`). |
| Notification | none | Every toggle and the frequency | Entirely local. Slack toggle shown when Slack is not connected. |
| Integration | Same slice as /integrations | Toggles call `connect(id)` with no credentials | Razorpay and WhatsApp toggles always fail ("Key ID is required.", `lib/api/integrations.ts:177-180`). Calls, Zoho and Zillow always fail (`lib/state/integrations.ts:90`). An OAuth popup opens from a switch. |
| Billing | `/api/billing`, checkout, portal, subscription, meters, audit export | Fallback demo prices when the catalog is empty (`change-plan-dialog.tsx:25`) | Change Plan not gated by role (`billing-panel.tsx:52`). Prices in ₹ while meters show $ (`invoice.ts:7`, `lib/api/billing-usage.ts:76`). Subscription card renders empty on error (`subscription-card.tsx:26,33-56`). The two billing gates disagree (`billing-audit-export.tsx:22` vs `lib/api/billing-usage.ts:4-5`). |
| Security | MFA (`/api/auth/mfa`); DSR export and delete (`/api/dsr*`, gated); Audit log drawer (`/api/audit-logs`); Data requests drawer; Widget origins (gated); Support access and delete workspace (owner only) | Live "View sessions" opens "The backend does not list sign-in sessions yet." (`sessions-dialog.tsx:24`); no live change password (`password-dialog.tsx:46-56`) | MFA shows the secret as text with no QR, although `otpauthUrl` is fetched (`mfa-control.tsx:64-68`). The toggle shows "on" before the code is confirmed (`:59`). DSR export polls with no busy state (`security-panel.tsx:52-75`). Access denial detected by matching the string "Forbidden" (`audit-log-drawer.tsx:86`, `data-requests-drawer.tsx:62`). |

**Inconsistencies inside Settings.**

- Two select components (`dropdown-pill.tsx` and `ui/select-pill.tsx`), plus native selects.
- An input class string repeated in more than ten files.
- Destructive confirms are yellow (`confirm-dialog.tsx:22-27`) in some places and orange in others.
- Confirm dialogs close before the async work finishes, so failures arrive later as toasts.
- `/api/settings` is fetched by three separate loaders (settings, team, widget).

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| SET-01 | P0 | Most settings save only in the browser behind a success toast | `lib/state/settings.ts:115`, `use-save-setting.ts:36`, `lib/api/settings.ts:11-12` | For each local-only card, either wire a backend field or remove the card. At minimum: profile name and time zone (user profile), notification preferences (new table), and the workforce "Approval Rules" and "Permissions" (fold into autonomy rules and allowlists, which already exist). Until then, label the cards "Preview: not saved to your workspace" and drop the success toast. | L (+ backend) |
| SET-02 | P1 | Settings > Integration toggles cannot work for key-based or unavailable tools | `integration-toggles.tsx:22-36` | Replace the toggles with the same card and Connect dialog as /integrations, or link there. | S |
| SET-03 | P1 | Kill switch has no confirm | `kill-switch-card.tsx:25-30` | Confirm dialog naming the effect ("All N employees stop replying and acting until you resume"). | S |
| SET-04 | P1 | No RBAC on autonomy, change plan, business name, learned preferences | `autonomy-rules.tsx`, `billing-panel.tsx:52`, `business-overview.tsx:78` | Gate on session role (X-RBAC-01). | S after X-RBAC-01 |
| SET-05 | P1 | MFA setup has no QR code; toggle shows on before confirm | `mfa-control.tsx:59,64-68` | Render a QR from `otpauthUrl` with a small dependency-free encoder (or a pinned library), and show "Pending" until confirmed. Recovery codes need backend work. | M |
| SET-06 | P2 | Dead "View sessions" in live mode; no change password | `sessions-dialog.tsx:24`, `password-dialog.tsx:46-56` | Hide sessions until the API exists. Add change password once `/api/auth/change-password` exists, or link to the reset flow with the email pre-filled. | S |
| SET-07 | P2 | Mixed currencies and fake fallback prices | `invoice.ts:7`, `lib/api/billing-usage.ts:76`, `change-plan-dialog.tsx:25` | One `formatMoney(cents, currency)` helper from the org currency. If the catalog is empty, show "Plans unavailable" instead of demo prices. | S |
| SET-08 | P2 | Subscription card and workspace switcher hide errors | `subscription-card.tsx:26`, `workspace-switcher-card.tsx:20`, `kill-switch-card.tsx:17` | Show an inline error with Retry in each card. | S |
| SET-09 | P2 | One global error banner for six loaders | `settings-shell.tsx:41-45` | Show each error in its own card. | S |
| SET-10 | P2 | Accessibility: label-in-name mismatch, duplicate control names, heading levels | `autonomy-fields.tsx:16-24,51-55`, `avatar-picker.tsx:70,78` | Drop `aria-label` overrides, rename the controls and fix the heading order. | S |
| SET-11 | P2 | Developer vocabulary (search mode "hybrid", tier keys, `patternKey`, rollout stage names) | `knowledge-library.tsx:136-156`, `learned-preferences.tsx:50-51`, `lib/api/team.ts:152` | Map to plain labels. | S |
| SET-12 | P3 | Stale docstrings ("Mock plan picker") and Figma notes | `change-plan-dialog.tsx:73`, `connect-dialog.tsx:117` | Update the comments. | S |

### 3.16 Platform admin (`/admin/*`)

**What it shows.** Eight pages: Overview, Organizations (and detail), Users, Billing, Health, Feature flags, Audit log
and Platform team (`components/platform/platform-nav.tsx:8-17`). The guard probes `/api/platform/orgs` and shows
"Forbidden" on 403 (`platform-guard.tsx:16-75`). Every mutation needs a reason of at least 12 characters
(`confirm-reason-dialog.tsx:25-71`). An impersonation banner polls every 60 s (`impersonation-banner.tsx:12-73`).

**Gaps.**

- No pagination or sorting anywhere (`org-table.tsx:26`, `audit-log.tsx:57`).
- Users are capped at 500, and search runs on the client, so users beyond 500 cannot be found
  (`users-directory.tsx:60-64`, `user-filters.ts:13-21`).
- Overview, Billing and Health read the guard's one-time snapshot and have no refresh (`directory-context.tsx`).
- Audit and Team errors have no Retry (`audit-log.tsx:18-24`, `team-table.tsx:16-22`).
- The impersonation banner is not mounted on `(flow)` routes. An operator impersonating a user who has not finished
  onboarding sees no banner there (`app/(app)/layout.tsx:13`, `app/(flow)/layout.tsx`).
- Tables scroll sideways on phones (`org-table.tsx:14`, `users-directory.tsx:91`).

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| ADM-01 | P1 | Impersonation banner missing on onboarding routes | `app/(flow)/layout.tsx`, `app/(app)/layout.tsx:13` | Mount `ImpersonationBanner` in the root layout for signed-in sessions. Security-sensitive. | S |
| ADM-02 | P2 | No server-side search or pagination for users and orgs | `users-directory.tsx:60-64`, `org-table.tsx:26` | Use `/api/platform/search` for users and add cursor paging. | M |
| ADM-03 | P2 | Snapshot pages never refresh; some errors lack Retry | `overview.tsx`, `audit-log.tsx:18-24` | Add Refresh and Retry. | S |

### 3.17 Legal, not-found and error pages

- `/legal/privacy` says "Sign in is a mock: no password, email or account is created, and nothing is sent to a
  server" (`app/legal/privacy/page.tsx:8-10`). That is false in live mode.
- `/legal/terms` says all data is sample data (`app/legal/terms/page.tsx:8-10`).
- Both carry "This is a demo build with mock data" (`components/landing/legal-page.tsx:8`).
- Signup requires agreeing to these terms (`components/onboarding/auth-form.ts:11`), and the checkbox label has no
  links (`auth-dialog.tsx:77`).
- `not-found.tsx` sends everyone to `/home`, which bounces signed-out visitors to sign-in (`app/not-found.tsx:11`).
- The error boundaries are consistent and calm (`components/layout/error-panel.tsx`). They do not log or report the
  error anywhere.

| ID | Sev | Finding | Evidence | Fix | Effort |
|---|---|---|---|---|---|
| LEGAL-01 | P0 | Live users consent to terms and privacy text that say the product is a mock | `app/legal/*/page.tsx:8-10`, `auth-form.ts:11` | Publish real terms and privacy text, or gate signup on their existence. This is a legal, human-only task: mark 🔴 until counsel provides text. | S (engineering) |
| LEGAL-02 | P2 | Terms checkbox label has no links | `auth-dialog.tsx:77` | Link "Terms" and "Privacy" in the label. | S |
| LEGAL-03 | P2 | Error boundaries do not report errors | `error-panel.tsx`, `app/(app)/error.tsx` | Send `error.digest` to the existing telemetry (Langfuse or server log endpoint). | S |

---

## 4. Gap-doc crosswalk: what the old-UI trackers say vs what NEW-FRONTEND does

The `gap26sept/` files were written against `apps/dashboard`. Many rows are 🟢 there because the old pages were
fixed. This table records whether the new UI carries the same capability. "Missing" means the backend exists and the
new UI has no surface for it.

| Gap doc | Capability marked done for the old UI | In NEW-FRONTEND? | Evidence |
|---|---|---|---|
| `home.md`, `dashboard-home.md` | Stats CTE, live needs-attention feed, health strip polling `/api/health/ready`, roster "View all" | Stats yes, needs attention yes (chips), **health strip missing**, roster partly (four mini cards) | `snapshot-card.tsx`, `attention-chips.tsx`, `populated-stack.tsx` |
| `home.md` | Quick Ask AI input routed to `/ask-ai?q=` | The ask bar exists, but `?q=` is not read: `/ask-ai` redirects to `/home` without the query | `next.config.ts:16` |
| `conversations.md` | Takeover toggle, internal notes, SLA badge, load older, attachments, RBAC 🟡 | Takeover yes, internal notes yes, load older yes, attachments as links only, **SLA badge missing**, RBAC UI missing | `thread-panel.tsx:191-263` |
| `connectors.md` | "Needs setup" badge, refuse popup when OAuth is unconfigured, typed test forms 🟡, logs tab | Badge yes (tooltip only), refusal yes, **no logs tab**, **no API runner** | `integration-card.tsx:34-38`, `manage-drawer.tsx` |
| `employees.md` | Profile page with activity and per-employee metrics, archive with reassign | Drawer with activity, metrics card and reassign: yes. **No standalone profile route** (no deep link). | `employee-drawer.tsx`, `employee-settings.tsx` |
| `work-items.md` | Kanban and list, create form, priority and assignee selects, event history | List in the Tasks tab, create dialog, drawer with selects and history: yes. **No Kanban**, no filters, no bulk. | `tasks-section.tsx`, `new-task-dialog.tsx`, `work-item-drawer.tsx` |
| `plans.md` | Edit params, history toggle, realtime via `plan_updated` | Edit and history yes. **Realtime missing.** | `plans-view.tsx`, `lib/realtime/events.ts:42-43` |
| `brain.md` | Hybrid search, create and upload (`.txt`, `.md`), revisions with restore, enable/disable, reindex | Yes, in Settings > Business > Knowledge. **No citations in chat.** | `knowledge-library.tsx`, `knowledge-revisions-dialog.tsx` |
| `analytics.md` | Range picker, CSV export, ROI and cost-health tabs, calibration | Range and export yes (export ignores the range), cards yes. **`gaps`, CSAT proxy flag and percentiles missing.** | `performance-section.tsx` |
| `settings.md` | Member remove and role change, invite rate limit, seat limit, autonomy PATCH | Team card yes. Autonomy yes. **Most other settings local only (SET-01).** | `team-card.tsx`, `autonomy-rules.tsx` |
| `onboarding.md` | `?setup=` hand-off and a post-warmup Integrations drawer on Home | **Missing**: there is no `?setup=` handling and no warmup state | `grep -rn "setup=" src` finds no handler |
| `billing.md` | Usage-blocked banner, in-app manage, cancel and change plan, invoice pagination | Usage cap shown in chat (link to billing). Subscription, cancel and change plan yes. **No usage-blocked banner in the shell.** | `assistant-overlay.tsx:97-101`, `subscription-card.tsx` |
| `autonomy.md` | Per-rule tier, confidence, reversibility; add rule; pending approve/reject | Yes in Settings > AI Workforce. Pending decisions in Actions and Observability (Approve only in Actions). **`expiresAt` countdown missing.** | `autonomy-rules.tsx`, `attention-card.tsx` |
| `audit-log.md` | `/audit` table with kind, date and risk filters, load older, trace links | Yes, as a drawer in Settings > Security. **No actor filter, no export, no live updates.** | `audit-log-drawer.tsx` |
| `dsr.md` | Privacy panel with export and delete, typed confirm, history, download | Yes (`data-privacy-dialog.tsx`, `delete-data-dialog.tsx`, `data-requests-drawer.tsx`). Progress needs a manual refresh. | `data-requests-drawer.tsx:85-89` |
| `listings.md` | CRUD, status, withdraw, keyset paging, currency filter | CRUD yes. **Currency filter and paging not visible.** MLS sync offered despite the 501. | `listings-panel.tsx` |
| `showings.md` | freeBusy check, reconnect URL, cancel, agenda | Agenda, book and cancel yes. **No `reconnectUrl` hand-off**: nothing under `components/real-estate` or `lib/api/showings.ts` reads it, so a disconnected calendar ends in an error toast instead of a reconnect button. | `showing-dialog.tsx` |
| `inquiries.md` | Advance buttons, SLA badge, load more, filters, realtime | Advance buttons and the SLA badge ("Reply overdue") yes. **Status and locality filters and realtime not found.** | `inquiries-panel.tsx:17-72`, `:58` |
| `realtime-stream.md` | Shared hook, presence, push subscribe (VAPID-gated) | Shared client yes, presence yes. **Push not wired** (`docs/BACKEND-WIRING.md:47`). Most event types ignored. | `lib/realtime/*` |
| `employees/*.md` | Auto / Pick one / Team selector, "Hand to <Name>", locked allowlist | Selector and hand-off exist **only in the overview's native chat**; absent from the default TrueForge chat | `ask-mode-picker.tsx`, `assistant-overlay.tsx:138-156` |
| `chat-coverage.md` | 154 chat tools and 83 tab actions, all 🔴 | Every tab action in this document is a UI-only path today. The vision doc proposes making each one reachable from chat. | `gap26sept/chat-coverage.md` |

Two consequences:

1. Domain trackers in `gap26sept/` that say 🟢 for a UI row are about the old dashboard. When NEW-FRONTEND is the
   only UI in production (`CLAUDE.md` says it is the UI users see), those rows need a second status column for
   NEW-FRONTEND. Otherwise they overstate what users get.
2. `00-summary.md` P1 "only 2 of 22 tabs subscribe to SSE" is fixed in the old UI but true again in the new one:
   only Conversations, Actions (approvals, work, activity) and Home chips react to events.

---

## 5. Cross-cutting findings

### 5.1 Design system consistency

**What is good.**

- One token file (`styles/tokens.css`): colours, radii, neumorphic shadows, motion durations.
- A primitives barrel (`components/ui/index.ts:1-23`): Button, Dialog, Drawer, Menu, SelectPill, Tabs, Toggle,
  Tooltip, Toast, Skeleton, StatCard, EmptyState, SearchPill, TextPill, ChatBar, Spinner.
- Primitives have tests (11 test files in `components/ui`).
- `prefers-reduced-motion` is respected globally (`app/globals.css:93`) and in several components.

**What drifts.**

| Pattern | Variants found | Evidence |
|---|---|---|
| Select | `SelectPill`, settings `DropdownPill`, native `<select>` | `ui/select-pill.tsx`, `settings/dropdown-pill.tsx`, `whatsapp-panel.tsx:66`, `autonomy-fields.tsx:53` |
| Confirm | Settings `ConfirmDialog` (yellow), real-estate `ConfirmDialog`, inline confirm panels, `window.confirm`, orange dedicated dialogs | `settings/confirm-dialog.tsx`, `real-estate/confirm-dialog.tsx`, `manage-drawer.tsx:102-134`, `employee-actions.tsx:50` |
| Text input | The class string `rounded-pill bg-surface px-4 … shadow-neu-inset` repeated in 10+ files; `TextPill` exists but is rarely used | `connect-dialog.tsx:78`, `plan-card.tsx:12`, `invite-dialog.tsx:42` |
| Inline error | `<p role="alert" className="text-sm text-danger">`, about 30 copies | across `components/` |
| Stat tile | `StatCard`, local `Stat` in integrations, local `Stat` in employee card | `integration-stats.tsx:19-29`, `employee-card.tsx:14-27` |
| Page header | `PageHeader`, `SectionHeader level=1`, hand-written `h1` | `integrations/page.tsx`, `actions-view.tsx:104`, `employees-view.tsx:26` |
| Date format | `en-US`, `en-IN` and the default locale mixed; a `formatDate` helper duplicated in 8 files | see [5.7](#57-internationalisation-and-formatting) |
| Approval UI | Attention card (approve only), decision card (approve and reject), plan card, chat Allow/Deny, brief row triage | five components for one concept |
| Chat surface | Native overlay, TrueForge thread, create-employee panel transcript, conversation thread | four bubble styles |

**Contrast and non-text contrast.**

- Text tokens meet AA on cream: `ink #676767` on `cream #fffff0`, and `ink-muted #6e6e6e` on `surface #f5f5db`
  (`styles/tokens.css:5-12`).
- Neumorphic inputs and buttons are drawn with shadows only, without a border. Their boundary against the surface is
  far below the 3:1 non-text contrast that WCAG 1.4.11 asks for. Low-vision users cannot find input edges.

**Dark mode.** None. The chat theme is explicitly locked to light (`trueforge-chat.tsx:146-147`). Not required, but
commonly expected in a daily-use tool.

| ID | Sev | Finding | Fix | Effort |
|---|---|---|---|---|
| X-DS-01 | P2 | Five approval components | One `ApprovalCard` primitive (vision doc, section 7) | M |
| X-DS-02 | P2 | Duplicated select, confirm, input and error patterns | Promote `ConfirmDialog` (with a danger variant), `TextField`, `FieldError`, `formatDate` and `formatMoney` into `components/ui` and `lib/format.ts`; migrate call sites | M |
| X-DS-03 | P2 | Input edges below 3:1 | Add a 1px `--color-rule` border on inputs and focusable surfaces, plus a stronger focus ring | S |
| X-DS-04 | P3 | No dark mode | Add dark tokens once the chat is native | L |

### 5.2 Onboarding and first-run experience

The journey today:

1. Sign in (email login hidden).
2. Eight questions, three of them never saved.
3. "Ready" screen where sending an empty message finishes.
4. Home opens on a TrueForge chat that does not contain the message the user just typed.
5. Back in the overview: a local checklist with a fake invite, a "getting ready" subline, and invented learning
   percentages.

What is missing to reach first value:

- Connecting the first channel. Onboarding does not, and the checklist links away to Integrations.
- Meeting the AI team: who was seeded, what each does, what each may do without asking.
- A first useful task done end to end, such as "summarise my inbox" or "reply to this WhatsApp".
- Getting the role right: no team invite step (`gap26sept/onboarding.md:94-95`).
- The backend's `?setup=` hand-off and warmup states are not used ([section 4](#4-gap-doc-crosswalk-what-the-old-ui-trackers-say-vs-what-new-frontend-does)).

| ID | Sev | Finding | Fix | Effort |
|---|---|---|---|---|
| X-FTUE-01 | P1 | No path from sign-up to first value | Chat-led setup: connect a channel, meet the team, run a first task (vision doc, section 9) | L |
| X-FTUE-02 | P2 | Checklist not derived from real state | HOME-05 | M |

### 5.3 Navigation and information architecture

- **The rail is icons only.** Tooltip labels appear on hover (`components/layout/rail-item.tsx:17-35`). There are no
  text labels, even on wide screens.
- **No user menu or org switcher in the shell.**
  - Logging out lives in Settings > Profile (`profile-form.tsx:48-57`).
  - Switching workspace lives in Settings > Business (`workspace-switcher-card.tsx`).
  - `gap26sept/00-workspace-connectivity.md:234-239` flags the missing switcher.
- **No link to the platform console** for operators.
- **Mobile.**
  - The rail is a vertical column beside the content on every page except Home, where a menu button hides it
    (`icon-rail.tsx:59-67`).
  - There is no bottom tab bar. On a 390 px phone, the 44 px rail plus padding takes about 20% of the width on every
    page.
- **Inconsistent titles.** Singular and plural mix: "Integration" (`integrations/page.tsx:14`), "Opportunity"
  (`opportunities-view.tsx:93`), "Conversation" (`conversations-view.tsx:112`).
- **Deep links lost.**
  - `RequireAuth` sends signed-out users to `/sign-in` without a return URL (`require-auth.tsx:19`).
  - Employees have no standalone route (drawer only).
  - Plans have no per-plan route.
- **Skip link.** None (`grep "Skip to"` finds nothing). With an eight-item rail before `main`, keyboard users tab
  through it on every page.
- **Prefetch.** Every rail link uses full prefetch (`rail-item.tsx:22-23`), which loads all eight sections' code on
  every page.

| ID | Sev | Finding | Fix | Effort |
|---|---|---|---|---|
| X-NAV-01 | P1 | No user menu, org switcher or role display in the shell | Add an avatar menu (name, role, org, switch org, settings, sign out, platform console when allowed) | M |
| X-NAV-02 | P1 | No search or command palette | Cmd/Ctrl+K palette: navigate, find a customer, conversation, employee or plan, and "Ask DareX: …" that sends to chat (vision doc, section 10) | M |
| X-NAV-03 | P2 | Mobile rail eats width; no bottom bar | A bottom bar with Chat, Inbox, Approvals, More below `md` | M |
| X-NAV-04 | P2 | No skip link | Add "Skip to content" as the first focusable element in `AppShell` | S |
| X-NAV-05 | P2 | Title singular/plural drift | Use plural page titles everywhere | S |
| X-GUARD-01 | P2 | `RequireAuth` and `RequireOnboarded` render `null` (blank screen) | Render the shell with a skeleton (`require-auth.tsx:33`, `require-onboarded.tsx:21`) | S |
| X-GUARD-02 | P2 | Deep link lost on sign-in redirect | Add `?next=` (same-origin path only, validated) and honour it after login | S |
| X-GUARD-03 | P3 | Sign-in flashes for signed-in users | `RedirectIfDone` should render nothing until the session is known (`redirect-if-done.tsx:19,33-39`) | S |

### 5.4 Notifications

- Realtime notices are collected app-wide (`lib/state/realtime.ts:17,59-72`). They are **shown only in the
  Conversations bell** (`components/conversations/bell-popover.tsx:34`, mounted at `conversations-view.tsx:80,126`).
  On any other page, an incoming "needs attention" event is invisible.
- Only three event types produce notices (`lib/realtime/events.ts:54-66`). Approvals created by employees, plans
  finishing, connector revocations, usage caps and DSR completion produce none.
- Notices are memory only: eight items, gone on reload (`lib/state/realtime.ts:13,17`).
- No browser push. The backend has VAPID-gated push subscribe (`gap26sept/realtime-stream.md` tracker #8). The frontend
  deliberately does not wire it (`docs/BACKEND-WIRING.md:47`).
- Notification settings are local only (SET-01), so they cannot drive any delivery.
- No email digest control backed by the server.

| ID | Sev | Finding | Fix | Effort |
|---|---|---|---|---|
| X-NOTIF-01 | P1 | No global inbox | A bell in the shell with an inbox drawer (vision doc, section 11), fed by the stream and a server-side list so it survives reload | M (+ backend list) |
| X-NOTIF-02 | P2 | Few event types become notices | Add `plan_updated` (finished or failed), approval created, `integration_updated` (revoked), usage cap, DSR done | S |
| X-NOTIF-03 | P2 | No web push | Service worker plus VAPID key endpoint, opt-in from the inbox | M |

### 5.5 Search and command palette

- No global search. Search exists per page:
  - employees by name (`employees-view.tsx:29-35`);
  - conversations by customer or message (`conversations/search-dialog.tsx`);
  - knowledge (`knowledge-library.tsx:121-133`);
  - platform orgs.
- No keyboard shortcut layer beyond Escape in Conversations and onboarding.
- See X-NAV-02 for the fix.

### 5.6 Performance

- **Chat bundle.** `@truefoundry/trueforge-ui` 0.4.1 is about 1.6 MB of JavaScript in `dist` (40 files; the largest
  chunks are 652 KB and 361 KB). Its dependencies include `monaco-editor` (98 MB on disk), `chart.js`,
  `react-router-dom`, `react-syntax-highlighter` and `react-markdown`. The package is loaded on `/home`, the first
  page after sign-in. It is dynamically imported with `ssr:false` (`trueforge-chat.tsx:16-29`), but the `Thread` and
  `useAui` imports at the top of the file are static (`:5-6`), and so is the CSS import. Measure with
  `next build` and the bundle analyser before deciding; the dependency list alone suggests several hundred KB of
  gzipped JavaScript on the critical path.
- **Unpinned and patched dependencies.**
  - `@truefoundry/trueforge-sdk ^0.2.1` and `@truefoundry/trueforge-ui ^0.4.1` use caret ranges (`package.json`).
  - A `postinstall` script patches files inside `node_modules/@assistant-ui/*` (`scripts/patch-assistant-ui.js`).
  - An upstream patch release can silently break the chat, and the patch can stop applying. The script only warns
    with `console.warn` when a target string is missing.
- **Waterfalls.**
  - Settings waits for six requests before any tab renders (`lib/state/settings.ts:50`).
  - Home waits for employees, integrations and stats before choosing its layout (`home-screen.tsx:38`).
  - Each slice loads on first use, so the first visit to a tab is a client waterfall: guard, then session, then
    slice. There is no server-side data fetching. Every page is a client component behind client guards.
- **Duplicate requests.** `/api/settings` is fetched by three loaders (settings, team, widget).
- **Prefetch.** Full prefetch of all rail routes (`rail-item.tsx:22-23`).
- **Mock modules in the live bundle.** About 30 files import `@/mocks/*` with a static import, so demo data ships to
  production users even when only demo mode reads it. Examples: `components/home/employee-mini-card.tsx:7-8`,
  `components/conversations/overview-panel.tsx:13`, `components/actions/actions-view.tsx:18`,
  `components/insights/insight-kpis.tsx:7`, `components/ai-employees/growth-panel.tsx:12`,
  `lib/state/threads.ts:11-12`, `lib/state/settings.ts:27`, `lib/api/settings.ts:4`, `lib/api/platform.ts:3`.
- **Polling.** The thread panel polls every 8 s as a safety net, at a quarter of that rate while the stream is up
  (`thread-panel.tsx:100-109`). This is fine. Everything else relies on the stream or manual refresh.

| ID | Sev | Finding | Fix | Effort |
|---|---|---|---|---|
| X-PERF-01 | P1 | Heavy third-party chat on the first page | Native chat (CHAT-01). If TrueForge stays, load it only behind a click, with pinned exact versions. | L |
| X-PERF-02 | P1 | Caret-ranged chat SDKs plus a postinstall patch of `node_modules` | Pin exact versions; make the patch script fail the install when a patch does not apply; track an upstream fix | S |
| X-PERF-03 | P2 | Settings six-call gate; Home three-call gate | Render each card as its own data arrives | M |
| X-PERF-04 | P2 | Mocks shipped in production | Load mocks with dynamic `import()` behind `isDemo` | M |
| X-PERF-05 | P3 | Full prefetch of every rail route | Use the default viewport prefetch | S |

### 5.7 Internationalisation and formatting

- No i18n library. All copy is inline English.
- Locales are mixed:
  - `en-IN` in insights, opportunities and real estate (`components/insights/performance-format.ts:13,20`,
    `components/opportunities/follow-up.ts:14`, `components/real-estate/format.ts:5`);
  - `en-US` in settings, actions and the audit log (`components/settings/subscription-card.tsx:15`,
    `components/actions/work-labels.ts:32`, `components/settings/audit-log-drawer.tsx:15`);
  - the browser default in the platform console and open loops (`components/platform/platform-format.ts:41`,
    `components/conversations/open-loops.tsx:66`).
- Currency is mixed: `₹` hardcoded in billing invoices, the quote dialog and the pipeline
  (`components/settings/invoice.ts:7`, `components/actions/quote-dialog.tsx:38`,
  `components/opportunities/opportunity-filters.ts:94`), and `$` in the growth panel and usage meters
  (`components/ai-employees/growth-panel.tsx:16`, `lib/api/billing-usage.ts:76`). The org currency setting
  (`gap26sept/home.md:70-72`) is not read.
- Time zones: real-estate dialogs use the browser zone (`showing-dialog.tsx:53`). The Profile tab offers five
  abbreviations (`mocks/settings.ts:14`). The Schedule card uses full IANA names (`workspace-schedule-card.tsx:16-19`).
- `lang="en"` is fixed on `<html>` (`app/layout.tsx:19`).

| ID | Sev | Finding | Fix | Effort |
|---|---|---|---|---|
| X-I18N-01 | P2 | Mixed locales and currencies | One `lib/format.ts` with `formatMoney`, `formatDate` and `formatNumber`, reading the org locale and currency (from `/api/settings`) | M |
| X-I18N-02 | P3 | No message catalogue | Extract strings when a second language is planned; not before | XL |

### 5.8 Accessibility (summary)

**Good.**

- WAI-ARIA tabs (`components/ui/tabs.tsx`).
- Native `<dialog>` with a focus trap and restore (`components/ui/modal.tsx:43-64,93`).
- `role="log"` on chat and threads.
- Labelled icon buttons.
- 44 px touch targets on mobile (`max-md:min-h-11` throughout).
- Reduced-motion support.
- Onboarding focus hand-off.

**Gaps.**

| Issue | Evidence |
|---|---|
| No skip link | X-NAV-04 |
| Field errors not announced (TextPill, SelectPill) | `components/ui/text-pill.tsx:35-37`, `select-pill.tsx:154-155` |
| Placeholder used as the visible label in TextPill | `text-pill.tsx:6,21` |
| Streaming chunks re-announced | CHAT-08 |
| Timed auto-advance in onboarding | ONB-05 |
| Label-in-name mismatch in autonomy fields | `autonomy-fields.tsx:16-24` |
| Cards silently hidden by height fitting | HOME-10 |
| Non-text contrast of neumorphic controls | X-DS-03 |
| Errors and successes share one polite toast region | `components/ui/toast.tsx:69-70`; errors should use `role="alert"` |
| `window.confirm` dialogs | EMP-07 |

| ID | Sev | Finding | Fix | Effort |
|---|---|---|---|---|
| X-A11Y-01 | P2 | Errors announced politely along with successes | Give the toast a `tone`; render errors in an assertive region | S |
| X-A11Y-02 | P2 | Field errors not live | Add `role="alert"` to `FieldError` (X-DS-02) | S |
| X-A11Y-03 | P2 | Placeholder-as-label | Visible labels in `TextPill` | S |

### 5.9 Role-based UI

The session has no role (`lib/state/auth.ts:14-21`). Role awareness exists only where a Settings card reads a flag
from its own endpoint:

- team (`team-card.tsx`)
- kill switch (`kill-switch-card.tsx`)
- schedule (`workspace-schedule-card.tsx`)
- widget origins (`widget-origins-card.tsx`)
- support access and delete workspace (`workspace-access-card.tsx`)
- data and privacy (`security-panel.tsx`)
- subscription (`subscription-card.tsx`)
- billing audit (`billing-audit-export.tsx`)
- knowledge (`knowledge-library.tsx`)

Everywhere else, members and auditors see controls the backend will refuse:

- approvals
- employees
- integrations
- autonomy
- conversations takeover
- change plan
- business name

| ID | Sev | Finding | Fix | Effort |
|---|---|---|---|---|
| X-RBAC-01 | P1 | No role in the session; no shared permission helper | Add `role` (and `orgId`, `orgName`, `platformRole`) to `GET /api/auth/session` and `SessionState`. Add `lib/permissions.ts` mirroring the backend helpers (`canManageOrgSettings`, `canReadAudit`, `canMutateBrain`, `canDisableEmployee`, `canManageBilling`, `canDecide`). Add `useCan(action)`. Hide or disable with a reason. Security-relevant: UI gating is a convenience; the backend stays the authority. | M |

### 5.10 State persistence and privacy

- Slices persist to `localStorage` by default (`lib/state/create-slice.ts:75`). Live slices with customer data opt out
  (`persist: false`). The local-only settings slice `settings-live` persists to the browser
  (`lib/state/settings.ts:34`). It holds profile email, phone and business details, and survives until the next
  sign-in, when `resetAllSlices` wipes it (`lib/state/auth.ts:68,76`).
- Onboarding answers persist (`dare.v1.onboarding`). Insight dismissals and the checklist persist.
- Cross-tab sync replays storage events (`lib/state/provider.tsx:7-12`). This is good for consistency, but it means
  local-only settings can disagree between devices without warning.

| ID | Sev | Finding | Fix | Effort |
|---|---|---|---|---|
| X-STATE-01 | P2 | Personal data in `localStorage` for settings that look server-backed | Move to the server (SET-01); persist UI preferences only (tabs, toggles) | M |

### 5.11 Error surfacing

- `reportError` reaches a toast only on views that mount `useLiveErrorToasts`: Actions, Insights, Opportunities, Plans
  and Observability. Integrations, Settings, Home and Employees do not, so slice write failures there are silent
  (INT-08).
- Success toasts are sometimes shown before the server confirms (ACT-03, INS-01).

| ID | Sev | Finding | Fix | Effort |
|---|---|---|---|---|
| X-ERR-01 | P1 | Silent write failures on pages without the error bridge | Mount one error-toast bridge in `AppShell` and remove the per-view hooks | S |

### 5.12 Testing

- There are 200 test files, and they run in demo mode by design (`lib/demo.ts:3`). Live paths are tested with mocked
  `fetch`.
- No end-to-end test runs against the backend (`docs/BACKEND-WIRING.md:51`).
- `RUN_AND_TEST_PROMPT.md` at the repo root describes a browser test. No Playwright suite exists in NEW-FRONTEND.

| ID | Sev | Finding | Fix | Effort |
|---|---|---|---|---|
| X-TEST-01 | P1 | No live end-to-end coverage of sign-in, chat, approval or connect | A Playwright smoke suite against a seeded stack: sign up, onboard, ask, approve a plan, connect a BYOK tool, reply in a thread | L |

---

## 6. Consolidated findings register

### 6.1 P0: fix before real customers

| ID | Area | Finding | Effort |
|---|---|---|---|
| CHAT-01 | Chat | Default chat bypasses the Ask AI pipeline (modes, plans, approvals, history); the backend always uses the Executive | L |
| CHAT-04 | Chat | Tool approvals show names only: no arguments, risk or expiry | M |
| CHAT-05 | Chat bar | Attach drops the file silently (Home, Actions, Conversations reply, Create, Ready) | S to hide |
| CHAT-06 | Chat bar | Mic types a hardcoded sentence | S to hide |
| CONV-00 | Conversations | "Ask {employee}" sends the text to a customer | S |
| ACT-01 | Actions | No Reject on approval cards | M |
| ACT-02 | Actions | Edited quote amount not sent; toast claims it was | S to M |
| HOME-04 | Home | Invite dialog fakes success | S |
| ONB-01 | Onboarding | First message lands in a chat the user does not see | S after CHAT-01 |
| SET-01 | Settings | Most settings saved only in the browser behind a success toast | L |
| LEGAL-01 | Legal | Consent to terms and privacy text that describe a mock | S (eng), human-only text |
| AUTH-01 | Auth | Email verification responses unhandled (P0 once the flag is on) | M |

### 6.2 P1: core journeys incomplete

| ID | Area | Finding | Effort |
|---|---|---|---|
| CHAT-02 | Chat | Native chat squeezed into a 24rem overlay | M |
| CHAT-03 | Chat | No markdown; tool results dropped; no result cards | L |
| CHAT-11 | Backend proxy | TrueForge proxy proxies unauthenticated requests and forwards cookies | S |
| AUTH-02 | Auth | Email sign-in hidden | S |
| LAND-01 | Landing | "Demo data only", "Demo build" in live | S |
| ONB-02 | Onboarding | No tool connection or team setup | L |
| ONB-03 | Onboarding | Three answers local only; silent save failures | M |
| HOME-01 | Home | Invented learning % and hours | S |
| HOME-02 | Home | "Getting ready" subline forever | S |
| HOME-05 | Home | Checklist local and click-ticked | M |
| HOME-07 | Home | Dead "AI Assistant Chat" prompt | S |
| EMP-01 | Employees | Live card stats are a single "Tools enabled" cell | M |
| EMP-02 | Employees | Scripted create flow, auto-picked name, fake delay | L |
| EMP-03 | Employees | No "Chat with {employee}" | S |
| CONV-01 | Conversations | No unified inbox and filters | L |
| CONV-02 | Conversations | No AI draft, canned replies or delivery state | L |
| ACT-03 | Actions | Success toast before the server answers | S |
| ACT-04 | Actions | Command sent to a chat the user cannot see | S after CHAT-01 |
| OPP-01 | Opportunities | Hardcoded "Sarah" in Call Now | S |
| OPP-02 | Opportunities | Follow-up date discarded | S |
| INS-01 | Insights | Contradictory toasts on Approve | S |
| INT-01 | Integrations | Load error renders a grid of Connect | S |
| INT-02 | Integrations | No RBAC | S after X-RBAC-01 |
| INT-03 | Integrations | Invented stats | S |
| SET-02 | Settings | Integration toggles cannot work for key-based tools | S |
| SET-03 | Settings | Kill switch without confirm | S |
| SET-04 | Settings | No RBAC on autonomy, plan change, business name | S after X-RBAC-01 |
| SET-05 | Settings | MFA without QR; premature "on" | M |
| ADM-01 | Admin | Impersonation banner missing on onboarding routes | S |
| X-RBAC-01 | Shell | No role in the session | M |
| X-NAV-01 | Shell | No user menu or org switcher | M |
| X-NAV-02 | Shell | No command palette or search | M |
| X-NOTIF-01 | Shell | No global notification inbox | M |
| X-FTUE-01 | Journey | No path from sign-up to first value | L |
| X-PERF-01 | Performance | Heavy third-party chat on the first page | L |
| X-PERF-02 | Performance | Caret-ranged chat SDK plus node_modules patch | S |
| X-ERR-01 | Errors | Silent write failures on several pages | S |
| X-TEST-01 | Testing | No live end-to-end suite | L |

### 6.3 P2 and P3

| Area | P2 | P3 |
|---|---|---|
| Landing and legal | LAND-02, LAND-03, LAND-05, LEGAL-02, LEGAL-03 | LAND-04, LAND-06 |
| Auth | AUTH-03, AUTH-04, AUTH-05, AUTH-06 | AUTH-07, AUTH-08 |
| Onboarding | ONB-04, ONB-05, ONB-06, ONB-07 | ONB-08, ONB-09 |
| Home | HOME-03, HOME-06, HOME-08, HOME-09, HOME-10, HOME-11 | none |
| Chat | CHAT-07, CHAT-08, CHAT-09, CHAT-10, CHAT-12 | none |
| Employees | EMP-04, EMP-05, EMP-06, EMP-07, EMP-08, EMP-09 | none |
| Conversations | CONV-03, CONV-04, CONV-05, CONV-06, CONV-07 | CONV-08 |
| Actions | ACT-05, ACT-06, ACT-07, ACT-09 | ACT-08 |
| Opportunities and real estate | OPP-03, OPP-04, OPP-05, RE-01, RE-02, RE-03 | RE-04 |
| Insights, Observability, Plans | INS-02, INS-03, INS-04, INS-05, OBS-01, OBS-02, PLAN-01, PLAN-02, PLAN-03 | INS-06, OBS-03 |
| Integrations | INT-04, INT-05, INT-06, INT-07, INT-08, INT-10 | INT-09 |
| Settings | SET-06, SET-07, SET-08, SET-09, SET-10, SET-11 | SET-12 |
| Admin | ADM-02, ADM-03 | none |
| Cross-cutting | X-DS-01, X-DS-02, X-DS-03, X-NAV-03, X-NAV-04, X-NAV-05, X-GUARD-01, X-GUARD-02, X-NOTIF-02, X-NOTIF-03, X-PERF-03, X-PERF-04, X-I18N-01, X-A11Y-01, X-A11Y-02, X-A11Y-03, X-STATE-01 | X-DS-04, X-GUARD-03, X-PERF-05, X-I18N-02 |

Counts: 12 P0, 38 P1, about 75 P2, about 18 P3.

---

## 7. Suggested fix order

Each wave is shippable on its own. Each fix is one commit in the NEW-FRONTEND repo, scope `new-frontend`, per
`NEW-FRONTEND/AGENTS.md`.

**Wave 0: stop misleading users (about 2 days, all S).**

1. Hide the chat-bar attach and mic in live mode (CHAT-05, CHAT-06).
2. Fix the Workspace "Ask" bar (CONV-00).
3. Swap the Home invite dialog for the real one (HOME-04).
4. Disable quote editing in live mode until `modify` is wired (ACT-02, first half).
5. Toast approvals only after the server answers (ACT-03, INS-01).
6. Gate demo copy on landing and legal (LAND-01). Escalate the legal text to a human (LEGAL-01).
7. Drop invented metrics: learning %, hours, "AI Employees Connected", "Live", permanent-dash KPI tiles
   (HOME-01, INT-03, INS-02).
8. Show load errors instead of a fake "nothing connected" grid (INT-01).
9. Mount one global error-toast bridge (X-ERR-01).
10. Fix the hardcoded "Sarah" (OPP-01).

**Wave 1: one chat, one approval model (about 1 to 2 weeks).**

1. The native Ask AI client becomes the full-height Home view (CHAT-01, CHAT-02, ONB-01, ACT-04, HOME-07, HOME-11).
2. Markdown rendering and the first tool-result cards (CHAT-03).
3. One `ApprovalCard` with Reject, preview, risk and expiry, used in chat, Actions and Observability (ACT-01, CHAT-04,
   ACT-05, X-DS-01). This needs the `args`, `risk` and `expiresAt` fields from the backend.
4. Quote `modify` wired end to end (ACT-02, second half).
5. Pin the TrueForge packages or remove them (X-PERF-02).

**Wave 2: shell and roles (about 1 week).**

1. Role in the session plus `useCan` (X-RBAC-01), then gate the pages (INT-02, SET-04, EMP-06, CONV-05).
2. User menu, org switcher and skip link (X-NAV-01, X-NAV-04).
3. Global notification inbox (X-NOTIF-01, X-NOTIF-02).
4. Command palette (X-NAV-02).
5. Skeleton guards and return URL (X-GUARD-01, X-GUARD-02).

**Wave 3: honest settings and first run (about 2 weeks, with backend work).**

1. Wire or remove the local-only settings (SET-01, X-STATE-01). Fix the Integration toggles (SET-02).
2. Email verification and visible email login (AUTH-01, AUTH-02).
3. Persist all onboarding answers (ONB-03). Derive the checklist from server state (HOME-05).
4. Chat-led setup: connect a channel, meet the team, first task (ONB-02, X-FTUE-01).

**Wave 4: depth (ongoing).**

- Unified inbox and AI drafts (CONV-01, CONV-02, CONV-07).
- Real hire flow (EMP-02) and per-employee metrics (EMP-01).
- Realtime for the event types the frontend ignores today (PLAN-01, RE-02, OPP-05, HOME-08).
- Performance work (X-PERF-01, X-PERF-03, X-PERF-04).
- Formatting (X-I18N-01).
- Live end-to-end tests (X-TEST-01).

When a wave lands, update the matching `gap26sept/<domain>.md` tracker rows with a NEW-FRONTEND column and record the
change in `BUILD_STATE.md`, per the repo rules in `CLAUDE.md`.
