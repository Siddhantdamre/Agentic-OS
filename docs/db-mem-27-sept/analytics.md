# Analytics

Date: 2026-09-27. Page: `apps/dashboard/app/(dashboard)/analytics/page.tsx`.
Routes: `apps/dashboard/app/api/analytics/`.

Every route uses `getScopedClient()`. Numbers come from SQL on `darex`
or from Langfuse. A Langfuse failure on cost returns HTTP 503 with
`verified: false`. The UI does not substitute zero.

## Overview — `GET /api/analytics?range=`

Ranges: `24h`, `7d` (default), `30d`, `90d`. Queries are bounded to that
window. The latency average scans at most the latest 2000 user messages
in the window, then a lateral lookup of the next assistant message.

Returned metrics:

| Field | Meaning |
|---|---|
| `totalConversations`, `resolvedConversations`, `activeConversations` | Counts on `conversations.started_at` in range |
| `totalMessages` | `messages` in range |
| `automationRate` and `conversationAutomationRate` | Same number. Conversations that have at least one assistant message, divided by conversations that have any message in range. This matches Home. |
| `toolExecutionRate` | Assistant messages whose `tool_calls` is non-empty, divided by assistant messages in range. Separate label. Not called automation rate. |
| `avgResponseTime` | Mean seconds from a user message to the next assistant message. `N/A` when there is no pair. |
| `csatScore` | Resolved conversations / total conversations, scaled to `/ 5`. `csatIsProxy: true`. This is not a survey. |
| `conversationChangePct` | This window vs the previous window of the same length. `null` when the prior window is empty. |
| `channelBreakdown` | Active `channels` grouped by `channel_type` (not range-filtered). |
| `weeklyTrend` | Conversation starts by weekday inside the range. |
| `metricPoints` / `gaps` | Registered insight metrics from `queryRegisteredMetrics`. Gaps are returned when a metric cannot be computed. |

The page has a range control and a CSV link to `GET /api/analytics/export`
(session org, no secrets).

## Other tabs

The analytics page loads these in parallel with the overview. Empty or
missing tables render an honest empty state.

| Route | Source |
|---|---|
| `GET /api/analytics/roi` | `employee_roi_metrics` (hours saved by role) and `growth_pipeline_attribution` (pipeline). Missing table (`42P01`) degrades instead of 500. |
| `GET /api/analytics/cost` | Weekly model spend from Langfuse via `fetchOrgWeeklyCost`. 503 if Langfuse fails. |
| `GET /api/analytics/cost-health` | Spend against `org_cost_ceilings` / `org_model_spend` (`029_org_cost_and_calibration.sql`). Ceilings default to 8 model calls per trigger, 50 actions per sweep, 2500 cents per day. |
| `GET /api/analytics/calibration` | Brier-style deciles from `agent_decision_ledger` joined to `outcome_feedback`. UI says when the last 90 days have no samples. |

## Still true limits

- Latency is a mean over a 2000-row sample. There is no P50 / P90 / P99.
- CSAT is the resolution ratio, labeled as a proxy.
- Aggregations use server time, not `org.timezone`.
- The overview is a fetch on load and on range change. It is not an SSE
  stream.
- Analytical queries use the same pool of 10 as chat. They are bounded,
  but they are not a replica or a daily rollup table.
