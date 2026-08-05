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

## Design System Tokens (from frontend architecture spec)
```
background: #FAF9F0 (warm cream)
primary:    #F0C05A (soft gold/amber)
surface:    #F5F2D8 (pale yellow-green)
heading:    dark green-gray
border-radius: 16-24px (fully rounded)
```
