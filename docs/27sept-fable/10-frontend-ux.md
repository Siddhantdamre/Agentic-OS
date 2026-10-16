# 10 · Frontend / UX / product surface

> ### 📊 Completion Status
>
> | Status | Count | Percentage |
> |---|:---:|:---:|
> | 🟢 **Done (Verified)** | 5 | 8.2% |
> | 🟡 **Pending / In Progress** | 1 | 1.6% |
> | 🔴 **Not Done (Open)** | 55 | 90.2% |
> | ⛔ **Blocked (Human/Infra)** | 0 | 0.0% |
> | **Total Findings** | **61** | **100.0%** |

Audit date 2026-09-27, read-only. Scope: `apps/dashboard/app/**` (38 pages, 4 route groups), `components/**`, `lib/event-bus.ts`, `middleware.ts`, `next.config.js`, `tailwind.config.js`, `app/globals.css`, `app/layout.tsx`, `docs/darex-frontend-architecture.md`, UI rows of `gap26sept/*.md`.

**Headline.** The pages exist and most fetch real APIs, but the shell is not enterprise-shaped: **no `error.tsx` / `loading.tsx` / `not-found.tsx` anywhere**; mobile nav reaches 5 of 21 destinations (Settings and Sign-out unreachable); `/plans` never shows "Edit params" (missing prop) and hides history; four pages render a fabricated "nothing here" empty state on API failure; optimistic updates without rollback; modals without focus trap or Escape; `alert()`×8 / `confirm()`×5 / `prompt()`×2 for critical actions; `docs/darex-frontend-architecture.md` describes shadcn / TanStack Query / RHF that are not in the codebase; zero page-level tests.

Global facts: every page is `'use client'` with raw `fetch` in `useEffect`; `@tanstack/react-query` in `package.json` with zero imports; RBAC server-side, only 7/38 pages adapt UI to role; `AppShell.tsx:147` hides the sidebar below `md`, `components/a11y/BottomTabs.tsx:14–20` exposes 5 destinations; 11 component test files, 0 page tests; no `hooks/` dir (the `useRealtimeStream.ts` documented in `realtime-stream.md:242` does not exist).

---

## 1. Page inventory

RT realtime · L loading · E error · EH honest empty (distinguishes none vs failed) · RB role-aware · M mobile · A a11y · T tests. ✅ / ⚠️ / ❌

| Route | Purpose | API | RT | L | E | EH | RB | M | A | T |
|---|---|---|---|---|---|---|---|---|---|---|
| `/` | Home snapshot + warm-up | stats, needs_attention, org/plan, health/ready | ❌ poll 2.5 s warm-up only | ⚠️ | ⚠️ retry = reload | ✅ | ❌ | ✅ | ⚠️ | ❌ |
| `/ask-ai` | Chat, plans, crews | ask-ai, conversations, plan, execute SSE, employees | ✅ SSE + abort | ✅ | ✅ | ✅ | ⚠️ | ⚠️ `innerWidth` | ⚠️ mention list no keyboard | ⚠️ 8 comps |
| `/conversations` | Inbox | conversations, messages, work-items | ✅ inline SSE + poll fallback | ✅ | ✅ | ✅ | ⚠️ | ❌ two-pane fixed | ❌ `<div onClick>` rows | ❌ |
| `/plans` | Approve / cancel / execute | plan, execute SSE | ⚠️ while executing | ✅ | ✅ | ⚠️ history filtered server-side | ❌ | ✅ | ⚠️ | ❌ |
| `/work-items` | Kanban / list | work-items (unbounded), decision | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ no `overflow-x` | ⚠️ no `aria-pressed` | ❌ |
| `/brain` | Knowledge | brain, brain/[id], reindex | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ unlabeled search | ❌ |
| `/listings` | RE listings | packs/listings → listings | ❌ | ✅ | ❌ swallowed | ❌ "No listings" on 500 | ❌ | ✅ | ⚠️ | ❌ |
| `/inquiries` | RE inquiries | inquiries | ❌ | ✅ | ❌ | ❌ | ❌ | ⚠️ | ⚠️ | ❌ |
| `/employees` | Roster, hire, crews | employees, stats, agent/crew | ❌ | ✅ | ⚠️ `alert()` | ✅ | ❌ | ⚠️ | ❌ modal no dialog semantics | ❌ |
| `/employees/[id]` | Detail | employees/[id], activity | ❌ | ✅ | ✅ | ✅ | ❌ read-only | ✅ | ✅ | ❌ |
| `/employees/growth` (+ `/growth` re-export) | Growth ops | employees/growth, decision | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ⚠️ | ⚠️ |
| `/employees/customer` | Customer board | employees/customer, open-loops | ✅ inline SSE, empty `onerror` | ✅ | ✅ | ✅ | ❌ | ✅ | ⚠️ | ⚠️ |
| `/brief` | Daily brief | brief?tz, triage | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ⚠️ | ❌ |
| `/insight` | Insight cards | insight | ❌ | ✅ | ❌ no `res.ok` | ❌ | ❌ | ❌ | ⚠️ | ❌ |
| `/analytics` | KPIs, cost, CSV | 4 parallel w/ cancel ✅, export link | ❌ | ✅ | ✅ | ✅ | ❌ | ⚠️ | ❌ div bars | ❌ |
| `/observability` | Metrics, decisions | metrics, decisions, alerts/dispatch dryRun on load | ❌ | ❌ none | ❌ none | ❌ | ❌ | ✅ | ⚠️ | ❌ |
| `/audit` | Audit log | audit?cursor&riskClass | ❌ | ✅ | ✅ 403 copy | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ |
| `/integrations` (legacy) | Grid | integrations | ❌ | ✅ | ✅ | ✅ | ❌ | ⚠️ | ⚠️ | ❌ |
| `/connectors`, `/connectors/[id]` | Nango, BYOK | integrations, connect | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ `grid-cols-3` | ❌ unlabeled inputs | ❌ |
| `/packs` | Install / config | packs, install, config | ❌ | ✅ | ⚠️ | ✅ | ❌ | ✅ | ⚠️ | ❌ |
| `/billing` | Plan, seats, usage | billing/* | ❌ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ❌ |
| `/skills` | Skill toggles | skills | ❌ | ⚠️ | ✅ | ✅ | ❌ | ✅ | ⚠️ | ❌ |
| `/settings` | Org, team, widget, keys, DSR, autonomy | settings, org/*, pending | ❌ | ✅ | ⚠️ `alert()`, silent `!ok` | ✅ | ✅ | ⚠️ | ❌ invite modal | ⚠️ |
| `/settings/autonomy` | Tiers + pending | settings/autonomy, pending | ❌ | ✅ | ❌ no catch | ✅ | ❌ | ✅ | ⚠️ | ✅ |
| `/showings` | RE showings | showings | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ | ⚠️ `confirm()` | ❌ |
| `/admin`, `/admin/orgs/[orgId]` | Platform | platform/* | ❌ | ✅ | ✅ forbidden text not 404 | ✅ | ✅ | ✅/⚠️ | ⚠️ no focus trap | ❌ |
| `/login`, `/register`, `/forgot-password`, `/reset-password`, `/invite/[token]` | Auth | auth/* | — | ✅ | ✅ (forgot: ❌) | — | — | ✅ | ⚠️ labels lack `htmlFor` | ❌ |
| `/onboarding/{name,team-size,business-type,channels}` | Wizard | org/onboarding fire-and-forget | — | — | ❌ | — | — | ✅ | ✅ `aria-pressed` | ❌ |

## 2. Bugs

| ID | Sev | Location | What happens | Fix sketch | Status |
|---|---|---|---|---|---|
| UI-B01 | **P0** | `app/` | No `error.tsx` / `global-error.tsx` / `not-found.tsx` in any route group → default white error page; unstyled 404. | Add all three at root + `(dashboard)/error.tsx` in `AppShell`. | 🟢 |
| UI-B02 | **P0** | `AppShell.tsx:147`, `BottomTabs.tsx:14–20` | Below `md` sidebar hidden; BottomTabs lists 5 items → Settings, Billing, Sign out and 14 tabs unreachable on mobile. | "More" sheet enumerating `NAV_ITEMS` + Settings + Sign out. | 🟢 |
| UI-B03 | P1 | `plans/page.tsx:336–345` vs `PlanCard.tsx:142` | `PlanCard` rendered without `onUpdateStepPayload` → "Edit params" never renders on `/plans` (ask-ai passes it at `:2180`). | Pass PATCH handler. | 🔴 |
| UI-B04 | P1 | `plans/page.tsx:124–126,156–158,161–173` | Optimistic updates with no rollback; `handleCancel` marks cancelled locally even on failure. | Snapshot + rollback + toast. | 🔴 |
| UI-B05 | P1 | `plans/page.tsx:204–271` | Execution SSE loop has no AbortController / unmount guard. | Abort in cleanup. | 🔴 |
| UI-B06 | P1 | `listings:21–29,86–91`; `inquiries:31–39`; `showings:28–31` | `fetchJson` returns null on any failure → "No listings / inquiries / showings" on 500 — **fabricated empty state**. | Throw on `!ok`; error banner + retry. | 🟢 |
| UI-B07 | P1 | `insight/page.tsx:55,67` | `res.json()` without `res.ok`; errors to console. | Same. | 🔴 |
| UI-B08 | P1 | `observability/page.tsx:58–70,75–97`; `PendingDecisionCard.tsx:13–14` | No `.catch`, no loading/error; failed approve/reject silent; no busy state → double submit. | try/catch, `loading`/`error`, disable while in flight. | 🔴 |
| UI-B09 | P1 | `AutonomySettings.tsx:65–86,98–133,139–170` | try/finally without catch → unhandled rejections; tier appears unchanged. | catch → `setError`. | 🟢 |
| UI-B10 | P1 | `OpportunityCard.tsx:49–61`, `DecisionCard.tsx` | `finish` try/finally; rejected `onDecision` leaves card open silently. | Inline error. | 🔴 |
| UI-B11 | P1 | `conversations/page.tsx:160–163` | `needs_attention` event hijacks the thread the user is reading. | Badge. | 🔴 |
| UI-B12 | P1 | `conversations/page.tsx:340–343,224–265` | Search refetch per keystroke, no debounce/abort; stale results overwrite. | Debounce + abort. | 🔴 |
| UI-B13 | P1 | `conversations/page.tsx:778,855,904,943,1043,1045` | Missing employee name falls back to literal `'Sarah'` / `'Sales Representative'` — fabricated identity. | "AI employee". | 🔴 |
| UI-B14 | P1 | `settings/page.tsx:145–153,168–176,191–199,229` | Save org, rotate widget key, save origins ignore `!ok`; invite uses `alert()`. | Check `ok`; inline error. | 🔴 |
| UI-B15 | P1 | `forgot-password/page.tsx:15–21` | No try/catch → `loading` stuck true forever on network error. | try/catch/finally. | 🔴 |
| UI-B16 | P1 | onboarding `name:16–20`, `team-size:15`, `business-type:32` | `void fetch` fire-and-forget; reload restarts wizard. | Await; block Continue. | 🔴 |
| UI-B17 | P1 | `connectors/[id]/page.tsx:467,669`; `integrations/page.tsx:226` | Customer-facing copy shows `http://localhost:3003` / `localhost:3000` endpoints. | Derive from origin. | 🔴 |
| UI-B18 | P1 | `components/platform/api.ts:31–48` | `classifyError` maps **any** 500/503 to `migrationMissing`. | Match specific code. | 🔴 |
| UI-B19 | P1 | `employees/page.tsx:169–174` | Archive with open tasks → `window.prompt` asking for a target employee **UUID**. | Select in dialog. | 🔴 |
| UI-B20 | P2 | `AppShell.tsx:104` | `startsWith` active check: `/employees/customer` lights two items; `/employees/growth` never lights "Growth" (href `/growth`). | Longest-prefix. | 🔴 |
| UI-B21 | P2 | `page.tsx:145–198`; `AppShell:65–74`; `OrganizationSwitcher:33–51`; brain, audit, work-items, growth, customer | Fetch without abort/cancel guard → setState after unmount. (`analytics`, `employees/[id]` do it right.) | One `useFetch`/react-query hook. | 🔴 |
| UI-B22 | P2 | `ImpersonationBanner.tsx:22–25,33–35` | 60 s poll, no cancel guard, polls for every tenant user. (2026-09-28: verified — partially fixed: initial load now has a `cancelled` guard (`:27-32`) and the interval is cleared on unmount, but the interval-triggered `load()` call itself doesn't check `cancelled`, and the banner is still unconditionally mounted in `AppShell.tsx:201` for every tenant user, not gated to platform role.) | Guard; mount only for platform role. | 🟡 (2026-09-28: initial load now has a `cancelled` guard; interval-triggered `load()` still lacks one; banner still mounts unconditionally for every tenant user in `AppShell.tsx:201`) |
| UI-B23 | P2 | `ask-ai/page.tsx:2033–2034,2042,2062,2216,2409` | Non-existent Tailwind classes `shadow-xs`, `py-0.2`, `w-4.5 h-4.5` — silent no-ops. | Fix classes. | 🔴 |
| UI-B24 | P2 | `BottomTabs.tsx:28`; `AppShell.tsx` | `safe-bottom`, `scrollbar-none` undefined → no iOS safe area, visible scrollbar. | Define utilities. | 🟢 |
| UI-B25 | P2 | `ask-ai/page.tsx:2499` | Enter-to-send without `isComposing` guard → CJK IME sends mid-composition. | Guard. | 🔴 |
| UI-B26 | P2 | `page.tsx:118` | `>= 0` always true; warm-up gate dead. | Fix. | 🔴 |
| UI-B27 | P2 | `middleware.ts:15–21` vs `admin/page.tsx:216–231` | Comment promises 404 for non-admins; page renders "forbidden" → leaks route. (2026-09-28: verified — still real; the admin page moved from `app/(dashboard)/admin/page.tsx` to `app/(platform)/admin/page.tsx` (same line range, :216-231, for the forbidden-text block) and the new `(platform)/layout.tsx` does no server-side admin check either, so the middleware comment claiming "the UI route group returns 404 for the page" still doesn't match: it's still a client-rendered "forbidden" message, not `notFound()`.) | `notFound()`. | 🔴 (2026-09-28: page moved `app/(dashboard)/admin/page.tsx` → `app/(platform)/admin/page.tsx`, same content — still renders a client "forbidden" text, no `notFound()`; finding still valid, just at a new path) |
| UI-B28 | P2 | `analytics/page.tsx:131–136`; `analytics/export/route.ts` | Export CSV ignores range/tab. | Append filters. | 🔴 |
| UI-B29 | P2 | `ConfirmReasonDialog.tsx:51–56`; `settings:747–833`; `employees:510–625`; `conversations:1069–1173` | Modals without focus trap / Escape / focus return; three lack `role="dialog"`. | One `<Dialog>` primitive. | 🔴 |

## 3. UX / functional gaps

| ID | Sev | Evidence | Enterprise target | Status |
|---|---|---|---|---|
| UI-G01 | P0 | `AppShell.tsx:37–60` 21 icon-only rail items, hover tooltips (`:118`) | Grouped labelled nav (Work / Employees / Data / Admin) + ⌘K command palette | 🔴 |
| UI-G02 | P0 | `api/ask-ai/plan/route.ts:30` filters pending/approved/running | Plan history (completed/cancelled/failed), search, per-step logs | 🔴 |
| UI-G03 | P1 | `settings/page.tsx:526–583` | Remove member, change role, resend/revoke invite, last-active | 🔴 |
| UI-G04 | P1 | MFA only at `login:15–16`; no enrolment page | Self-service MFA enrolment, recovery codes, session list, password change | 🔴 |
| UI-G05 | P1 | `audit/page.tsx:79–92` risk filter only | Date/actor/action/target filters, search, CSV/JSON export, deep link | 🔴 |
| UI-G06 | P1 | `work-items:216` fetch all; approve/reject no confirm (`245–257`) | Server pagination, filters, bulk actions, confirmation | 🔴 |
| UI-G07 | P1 | Only conversations + employees/customer subscribe to SSE | One shared SSE hook feeding Home, Plans, Work Items, Brief, Observability, Insight | 🔴 |
| UI-G08 | P1 | `conversations:528+` dark `#121917` palette vs cream shell | One theme | 🔴 |
| UI-G09 | P1 | `conversations:47` `assigned_user_id` typed, no UI; channels hardcoded (`650–658`) | Assign-to-human, notes, canned replies, channel list from API | 🔴 |
| UI-G10 | P1 | No toast primitive; `alert()`×8, `confirm()`×5, `prompt()`×2 | Toast system, accessible confirm, notification centre | 🔴 |
| UI-G11 | P1 | tabs in state (`settings:52`); brain query via `window.location.search:69` | URL-addressable `?tab=`, `?range=` | 🔴 |
| UI-G12 | P1 | `listings:64,71–73` defaults INR/Mumbai; `growth:148`, `analytics:355`, `billing:500` hardcode `$` | Org currency/locale/timezone; `Intl` everywhere | 🔴 |
| UI-G13 | P1 | 36 `toLocale*` with browser tz; only `brief:34`, `SchedulePanel:66` send tz | Org timezone applied to all timestamps | 🔴 |
| UI-G14 | P2 | `analytics:238–253` div bars | Real chart with axes, tooltips, table fallback | 🔴 |
| UI-G15 | P2 | `employees/[id]` read-only; `AVAILABLE_TOOLS` hardcoded (`employees:61–74`) | Edit persona/allowlist/autonomy; tool list from catalog | 🔴 |
| UI-G16 | P2 | `packs/page.tsx:141` config via `window.prompt` JSON | Schema-driven form | 🔴 |
| UI-G17 | P2 | `/showings` not in nav; `/admin` URL-only | Nav gated by pack/role | 🔴 |
| UI-G18 | P2 | `OrganizationSwitcher.tsx:108` full reload | Soft refresh | 🔴 |
| UI-G19 | P2 | `(auth)/layout.tsx:75` "Phase 3 Ready • Postgres RLS • Self-Hosted Stack" | Remove internal jargon | 🔴 |
| UI-G20 | P2 | `ask-ai:232–250,1985–1987` "DareX Executive", "TrueForge", "Just now" hardcoded | From API; real timestamps | 🔴 |

## 4. Enterprise readiness

| ID | Area | Evidence | Target | Status |
|---|---|---|---|---|
| UI-E01 | Security headers | `next.config.js` no `headers()` | CSP with nonce, HSTS, X-Frame-Options, Referrer-Policy; `frame-ancestors` only for widget | 🔴 |
| UI-E02 | i18n | `lang="en"`; no library | `next-intl`; RTL | 🔴 |
| UI-E03 | Dark mode / theming | no `darkMode`; `dark:` only in dead `OpenUiFenceBlock` | `darkMode:'class'`, CSS-variable tokens | 🔴 |
| UI-E04 | Branding / white-label | hex-coded palette | Per-org tokens | 🔴 |
| UI-E05 | RBAC UI | 7/38 role-aware; viewers see mutate buttons then get 403 | Session role in context; hide/disable per capability | 🔴 |
| UI-E06 | Session UX | no idle-timeout warning; 401 → hard redirect | Idle modal; re-auth without losing draft | 🔴 |
| UI-E07 | Incident UX | `SystemDegradationBanner` polls 30 s; no request id in errors | Surface `x-request-id` | 🔴 |
| UI-E08 | Export | only analytics CSV; DSR panel | Export on audit, conversations, work items | 🔴 |
| UI-E09 | a11y conformance | no jest-axe; icon-only nav; dialogs without traps | WCAG 2.1 AA gate in CI | 🔴 |
| UI-E10 | Fonts / perf budget | Inter named, never loaded; no budget | `next/font`; bundle analyzer budget | 🔴 |
| UI-E11 | UI observability | no client error reporting | Sentry browser + web-vitals keyed by org | 🔴 |
| UI-E12 | Docs drift | `darex-frontend-architecture.md:9–19,54–57,128–133` claims shadcn, Tremor/Recharts, TanStack Query, RHF+Zod, SuperTokens React SDK, WebSocket — none exist | Rewrite | 🔴 |

## 5. Design system & a11y

- Tokens (`cream-*`, `amber-*`, `heading`) exist but bypassed: raw hex in `billing:437`, all of `(auth)/layout.tsx`, `conversations:528+`; `PlanCard.tsx:73,113` slate/blue off-palette.
- No shared primitives: 12 files contain their own `fixed inset-0` overlay; `components/a11y/` has only `LiveRegion`, `StatusBadge`, `ConfirmButton`, `BottomTabs`.
- Tabs are buttons in a div — no `role="tablist"`, `aria-selected`, arrow keys (`settings`, `analytics`, `insight`, `employees`).
- Labels not associated: `login:275,297,343`, `register:181,197,237`; unlabeled inputs: `brain:118–124`, `observability:153`, `connectors/[id]:474–476`, `CrewSpawnPanel.tsx:77–83`, `forgot-password:35`; 12 `<select>`, 0 `aria-label`.
- Non-keyboard interactive: conversation rows `<div onClick>` (`738–749`); mention list and `OrganizationSwitcher` listbox without arrow keys / `aria-activedescendant`.
- Dialogs: only `ConfirmReasonDialog:53–54` and `EmailDraftPreviewModal:217–218` set `aria-modal`; none trap focus; Escape handled in 4 components.
- Motion: `framer-motion` in 5 chat components, no `prefers-reduced-motion`.
- Positives: `aria-pressed` on onboarding choices; `LiveRegion` for streaming; `Suspense` around `useSearchParams` in `connectors`, `login`.

## 6. Performance

- `ask-ai/page.tsx` 2,569 lines in one client module; `conversations` 1,190; `admin/orgs/[orgId]` 1,022 — no `next/dynamic` except `FormattedMarkdownResponse.tsx:22`.
- `FormattedMarkdownResponse.tsx:56–70` regex-parses markdown on every render of every message while streaming; no memo.
- Polling stack on every page: `SystemDegradationBanner` 30 s, `ImpersonationBanner` 60 s, Home warm-up 2.5 s × 5, `DsrPrivacyPanel` 3 s, conversations 5 s fallback; `/api/health/ready` fetched by three components with no shared cache.
- Unbounded lists: work-items, plans, employees in ask-ai (`:837–900`); `pendingPlans` computed client-side.
- `OrganizationSwitcher:108` full reload; Home retry reload; `export const dynamic='force-dynamic'` on a client page (`page.tsx:9`).
- Inter declared, never loaded (no `next/font`).

## 7. Dead / duplicate

| Item | Evidence |
|---|---|
| `components/inbox/DecisionCard.tsx` | zero imports outside its test; third approval card alongside `DecisionCardPanel`, `PendingDecisionCard` |
| `(dashboard)/growth/page.tsx:1` | re-export; two URLs one screen |
| `/integrations` vs `/connectors` | both fetch `/api/integrations`; placeholder `apiQuotaUsed:'0.0%'` (`:101`) |
| Two inline SSE implementations | `conversations:117–221`, `employees/customer:77–90` |
| `fetchJson` duplicated | listings, inquiries |
| Unused deps | `@tanstack/react-query`, `clsx`, `tailwind-merge` (0 imports) |
| Undefined utilities | `safe-bottom`, `scrollbar-none` |
| `api/showings/calendar-watch/calendar-watch/route.ts` | nested duplicate |
| `ProfileAvatar` (`AppShell:65–74`) | `cursor-pointer` no handler; tooltip shows raw org UUID |

## 8. Test coverage

| Area | Present | Gap |
|---|---|---|
| Chat | 8 component tests | `EmployeeModeSelector`, `ConnectorSignInLink`, `OpenUiFenceBlock`, page streaming/abort/history |
| Growth | `OpportunityCard` | rejection path |
| Inbox | `DecisionCard` | protects dead code |
| Settings | `AutonomySettings` | failure path; `DsrPrivacyPanel` |
| Pages | **0/38** | shell, BottomTabs, switcher, banner, dialogs, auth/onboarding forms |
| a11y | none | jest-axe, keyboard nav |
| E2E | none | Playwright on the six owner surfaces |

## 9. Fix order for this domain

1. **UI-B01 / B02 / G01** — error/not-found boundaries, mobile "More" sheet, grouped nav + ⌘K.
2. **UI-B03 / B04 / B05 / G02** — plans page integrity + history.
3. **UI-B06–B10, B14–B16** — honest error states everywhere; one `useFetch` hook (B21) — or actually adopt the already-installed react-query.
4. **UI-B29 / G10** — `<Dialog>` and toast primitives; delete `alert/confirm/prompt`.
5. **UI-E01 / E05** — security headers; role context hiding mutate controls.
6. **UI-G07** — shared `useRealtimeStream` hook (pairs with CH-B02).
7. **UI-G12 / G13 / E02** — org locale/currency/timezone + i18n scaffold.
8. **UI-E09 / E11** — jest-axe in CI, Sentry browser; Playwright smoke on `/`, `/ask-ai`, `/conversations`, `/employees`, `/plans`, `/settings`.
9. **UI-E12** — rewrite `darex-frontend-architecture.md` to match code.
