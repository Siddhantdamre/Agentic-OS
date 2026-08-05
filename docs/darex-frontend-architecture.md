# Darex Frontend — Detailed Architecture

Companion doc to `darex-ai-employee-platform-build-spec.md`. Covers the frontend specifically: stack, design system, page-by-page breakdown matched to the Figma screens, state management, real-time behavior, and module structure.

---

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | **Next.js (App Router)** | Server components for data-heavy pages (Insight, Analytics), client components only where interactivity is needed (chat bar, live conversation feed) — keeps initial load fast per org |
| Styling | **Tailwind CSS** | Matches the soft cream/yellow palette in the Figma exactly via custom design tokens, no fighting a component library's default theme |
| Component primitives | **shadcn/ui** | Unstyled, composable primitives (dialog, dropdown, tabs, tooltip) you fully re-skin — not a themed component library you fight against |
| Charts / data viz | **Tremor** or **Recharts** | Tremor for dashboard-style KPI cards and trend lines (Insight, Analytics pages); Recharts if you need more custom chart types later |
| Server state | **TanStack Query (React Query)** | Every dashboard number (conversations today, response time, CSAT) is server state — cache, revalidate, and background-refresh without hand-rolled fetch logic |
| Client/UI state | **Zustand** | Sidebar collapse state, active employee selection, wizard step — small, doesn't need Redux's ceremony |
| Real-time | **WebSocket (via Chatwoot's existing socket layer) + Server-Sent Events for AI streaming** | Conversation list updates push over the Chatwoot socket you already forked in; an AI employee's in-progress reply streams token-by-token over SSE so the owner sees it "typing" |
| Forms | **React Hook Form + Zod** | Onboarding wizard and settings forms — schema validation shared between client and API route |
| Auth | **SuperTokens React SDK** | Matches the backend auth choice, session handling out of the box |

---

## 2. Design System

Pulled directly from the Figma screens — codify these as Tailwind theme tokens so every new screen matches without eyeballing colors.

**Palette**
- Background: warm off-white / cream (`#FAF9F0`-ish base, shifts slightly warmer on gradient screens)
- Primary accent: soft gold/amber (`#F0C05A`-ish) — used for active nav state, primary buttons, progress indicators, the tree/orange illustration accents
- Secondary surface: pale yellow-green cards (`#F5F2D8`-ish) — used for stat cards, "Needs Attention" pills
- Text: dark green-gray for headings (matches "DareX ai" wordmark), muted gray for secondary text
- Status colors: keep muted/pastel versions even for "Critical" — the whole UI avoids harsh red/error colors in favor of amber-toned urgency, consistent with the calm brand tone

**Typography**
- Large, light-weight serif or humanist sans for page titles ("Conversation", "Insight", "Good Morning, Chintu") — big, airy, low visual weight despite large size
- Standard sans (Inter or similar) for body/data text
- Numbers in stat cards are bold and large — they're the focal point of every card

**Spacing & shape**
- Fully rounded corners on everything — cards, buttons, input fields, pills (large border-radius, ~16-24px)
- Generous padding, lots of whitespace — this is not a dense enterprise dashboard, it reads more like a calm consumer product
- Icon sidebar is narrow, icon-only (no labels), consistent across every page

**Illustration**
- The growing tree/citrus motif appears only in onboarding + the Home "warm-up" state — it's a progress metaphor, not a persistent UI element. Don't scatter it across data-dense pages like Insight or Analytics.

---

## 3. App Shell

**Persistent left sidebar** (icon-only, ~72px wide), present on every authenticated page:
1. Home (grid icon)
2. Sparkle/AI (likely "Ask AI" or agent-creation shortcut)
3. Conversations (chat icon)
4. Employees (people icon)
5. Insight (bulb icon)
6. Analytics (chart icon)
7. Integrations (branch/connector icon)
8. Settings (gear icon, pinned to bottom)

Active state = filled amber pill background behind the icon. This sidebar is a single shared layout component (`<AppShell>`) — every page is a child route rendered into its content slot, never re-implements the sidebar.

**Secondary panel pattern**: several pages (Conversations, Employees/Workspace) show a persistent "Employee" list panel to the right of the icon sidebar and to the left of main content. This is a shared `<EmployeeListPanel>` component, not duplicated per page — it's identical in the Conversation and Workspace screens in the Figma.

---

## 4. Page-by-Page Breakdown

### 4.1 Onboarding Wizard (`/onboarding/*`)
- Single-question-per-screen pattern, centered card, tree illustration grows fuller each step (component: `<GrowthTree progress={step/totalSteps} />` — an SVG with staged leaf/fruit reveal, not a new illustration per step)
- Steps: Name → Team size (slider, `<RangeSlider>`) → Business type (searchable dropdown, `<ComboboxSelect>`) → Channels (multi-select icon grid, `<IconMultiSelect>`)
- Each step is its own route (`/onboarding/name`, `/onboarding/team-size`, etc.) so back/forward browser nav works naturally and state persists in a Zustand `onboardingStore` until final submit
- Final submit creates the org, kicks off backend provisioning, redirects to Home in warm-up state

### 4.2 Home / Warm-up (`/`)
- Two-state page depending on provisioning status:
  - **Warm-up state**: "Your business is coming online" card with real progress (employees created / integrations connected / estimated completion) polled via React Query every few seconds until complete
  - **Steady state**: full snapshot — same layout, numbers just populate with real data once provisioning finishes
- Right column stacks: employee preview cards (Sarah/Emma-style, live conversation counts), Today's Snapshot (4-stat grid), Needs Your Attention (pill list), Recent Activity (timestamped feed) — each is an independently-fetching component so a slow one (e.g., Recent Activity) never blocks the others from rendering
- Bottom "Ask anything" bar with suggested-prompt chips — submitting sends to the org-level AI assistant endpoint, response can open a side panel or navigate to a relevant page depending on intent (e.g., "Show connected apps" → navigates to `/integrations`)

### 4.3 Conversations (`/conversations`)
- Top stat row (4 cards: total conversations, avg response time, % needing human review, CSAT) — these pull from the aggregation service (Phase 7 of the build spec), cached and revalidated, not computed client-side
- Right column: Quick Actions (static action buttons), Needs Attention (live queue, each item deep-links into the specific conversation thread), Recent Activity feed
- Employee list panel on the left filters/scopes the view when an employee is selected
- Clicking into a conversation opens the actual thread — this is where the WebSocket connection matters: new messages append live without a refetch

### 4.4 Employees → Workspace (`/employees/[id]`)
- Selecting an employee from the list panel routes here
- Header: employee name + role
- Stat row specific to that employee (conversations today, qualified leads, meetings booked — the stat set can differ by role, driven by a per-role config, not hardcoded per page)
- Needs Attention + Recent Customer Activity scoped to just this employee
- **"Ask [Employee]..." chat bar** — this is a direct line to that employee's LangGraph agent, streamed via SSE, distinct from the org-level "Ask anything" bar on Home. Useful for the owner to query/test/direct a specific employee without going through a real customer channel.

### 4.5 Insight (`/insight`)
- Tab bar (All / Critical / Growth / Customer / Performance / Positive / Resolved) — client-side filter over a single fetched dataset, not separate API calls per tab, to avoid refetch jank
- 4 top-level score cards (Business Health, Revenue Opportunity, Critical Issues, AI Efficiency)
- Card list below: each insight card pairs a diagnosed problem (left) with a recommended action (right, amber highlight) and a "Review Action →" button that triggers a real backend workflow (e.g., enqueues a Temporal workflow for "start automated follow-up") — this button must show a loading/confirmation state, never fire-and-forget silently, since it's changing something in the customer's actual workflows

### 4.6 Integrations (`/integrations`)
- 4-stat header (connected apps, AI employees connected, sync status, data health)
- Grid of integration cards, each with logo, name, channel/category tag, and Connected/Manage or Connect button
- "Connect" triggers the Nango OAuth flow in a popup/redirect; "Manage" opens a settings drawer (scope, disconnect, view sync log)
- This page polls sync status lightly (not real-time-critical) — a stale "last synced 2 mins ago" is fine to be a few seconds behind

### 4.7 Analytics (referenced in sidebar, not yet in provided screens)
- Build as a Tremor-driven page once Phase 7's aggregation service is live — trend charts over the same metrics surfaced as single numbers elsewhere (conversations, response time, CSAT) plotted over time, filterable by employee/channel/date range

---

## 5. State & Data-Fetching Pattern

- **Every stat card is its own React Query hook** (`useConversationStats(orgId)`, `useEmployeeStats(employeeId)`, etc.) — never one giant "dashboard data" fetch. This means a slow query for one card doesn't block the rest of the page from rendering, and each can have its own polling interval.
- **Optimistic updates** for anything the owner directly triggers (approving a discount, connecting an integration) — update the UI immediately, roll back on error, so the app never feels laggy even if the backend workflow takes a moment to actually complete.
- **SSE for AI responses** in both the Home "Ask anything" bar and the per-employee "Ask [Employee]" bar — stream tokens as they generate rather than waiting for the full response, matching the "typing" feel users expect from AI chat.

---

## 6. Component / Folder Structure

```
/apps/dashboard
  /app                      (Next.js App Router pages)
    /(onboarding)/...
    /(dashboard)/
      /page.tsx              → Home
      /conversations/...
      /employees/[id]/...
      /insight/...
      /integrations/...
      /analytics/...
      /settings/...
  /components
    /shell                   → AppShell, Sidebar, EmployeeListPanel
    /cards                   → StatCard, ActionCard, InsightCard, IntegrationCard
    /chat                    → ChatBar, StreamingMessage, ConversationThread
    /onboarding              → GrowthTree, RangeSlider, ComboboxSelect, IconMultiSelect
    /ui                      → shadcn primitives, re-skinned
  /hooks                     → useConversationStats, useEmployeeStats, useInsights, etc.
  /stores                    → onboardingStore, uiStore (Zustand)
  /lib                       → api client, SSE client, design tokens
```

Match this structure to backend modularity: one hook per backend service boundary (Chatwoot data, Temporal workflow status, Insight aggregation service) so a change in one backend service touches exactly one hook file, not scattered fetch calls across pages.

---

## 7. Mobile & Responsiveness

The Figma screens are desktop-first (fixed sidebar, multi-column layouts). For mobile:
- Sidebar collapses to a bottom tab bar (same 8 icons, no labels, same active-pill treatment)
- Employee list panel becomes a slide-over drawer instead of a persistent column
- Stat card rows go from 4-across to a horizontal scroll or 2x2 grid
- Chat bars (Ask anything / Ask employee) stay fixed at the bottom, same as most mobile chat UX

---

## 8. Accessibility notes
- Icon-only sidebar needs `aria-label` on every nav item (no visible text label to rely on)
- Streaming SSE responses need an `aria-live="polite"` region so screen readers announce the AI's reply as it completes, not mid-stream token by token
- Color-coded status (Needs Attention pills, Critical insight cards) needs a non-color indicator too (icon or text label) since the palette is intentionally low-contrast/pastel
