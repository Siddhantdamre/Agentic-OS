# apps/dashboard — Darex Dashboard (Next.js App Router)

The owner-facing dashboard UI. Built fresh per the spec — not forked from anything.

**Status:** Placeholder. Core structure scaffolded in **Phase 1**, pages filled in progressively through Phases 2-9.

## Stack
- **Next.js 14** (App Router) — server components for data-heavy pages, client components for interactivity
- **Tailwind CSS** — custom design tokens for the Darex cream/gold palette
- **shadcn/ui** — unstyled primitives, re-skinned to Darex design
- **Tremor** — KPI cards and trend charts (Insight/Analytics pages)
- **TanStack Query** — server state management
- **Zustand** — UI state (sidebar, wizard steps)
- **SuperTokens React SDK** — auth session handling

## Pages (from frontend architecture spec)
| Route | Phase | Description |
|---|---|---|
| `/onboarding/*` | 1 | Multi-step wizard |
| `/` | 1 | Home / warm-up state |
| `/conversations` | 3 | Aggregate conversation view |
| `/employees/[id]` | 4 | Per-employee workspace |
| `/insight` | 7 | AI-generated business diagnostics |
| `/integrations` | 2 | OAuth connect/manage channels |
| `/analytics` | 7 | Trend charts over aggregated data |
| `/settings` | 1 | Org settings |

## Public chat widget (H6)

Copy from **Settings → Webhooks & API Keys**, or paste:

```html
<script src="http://localhost:3000/embed/widget.js" data-site-key="YOUR_SITE_KEY" async></script>
```

`YOUR_SITE_KEY` comes from Settings (generate/rotate). `src` must be `NEXT_PUBLIC_APP_URL/embed/widget.js` in production. The script never includes `org_id`. Missing/invalid key → 401.

## Design System Tokens (from frontend architecture spec)
```
background: #FAF9F0 (warm cream)
primary:    #F0C05A (soft gold/amber)
surface:    #F5F2D8 (pale yellow-green)
heading:    dark green-gray
border-radius: 16-24px (fully rounded)
```
