# Feature coverage run, 17 Oct 2026

Run on the production build of the dashboard, in headless Chromium, on a demo workspace (three listings and enquiries, a viewing, money owed, two customer chats, two held emails). Script: `reports/feature-sweep.js`. Flows: `infra/harness/flows.js`.

**Simulated in every row below:** the AI model, Gmail and the connection broker are local stand-ins. Nothing here proves real model answers, real email or WhatsApp delivery, real payments or real Temporal runs.

## Results

| Area | Status | Evidence |
|---|---|---|
| Business flows (27 flows, 118 checks) | PASS | 118 passed, 0 failed |
| 29 signed-in screens load, show content, no error text | PASS | 29 of 29 |
| Every safe control on each of those screens used once | PASS | no script error, no unexpected 5xx (68 of 70 on first run; the other 2 are in the next two rows) |
| Ask AI answers a question on screen | PASS | |
| Approvals lists both held emails with recipients, approving shows a result | PASS | |
| Phone width (Home, Approvals, Money owed) | PASS | no sideways scroll |
| Sign in, sign up, forgot and reset password, verify email screens | PASS | all load |
| Demo owner signs in through the real form | PASS | |
| Insight: "Review Action" | ENVIRONMENT ISSUE | `/api/insight` answers 503 because no Temporal runs in this sandbox. The screen printed "Temporal is unavailable — InsightActionWorkflow was not started" under every card. **Product defect found and fixed** (test first): the message is now a plain sentence. |
| Billing: "Start checkout" | BLOCKED | `/api/billing/checkout` answers 503 by design when no Stripe or Razorpay keys exist. The screen says the providers are "not set up yet". Needs real keys. |
| Real model answers, wording quality | NOT TESTED | needs a model key |
| Gmail, WhatsApp, Shopify, Zendesk, Razorpay, Stripe, calendar | NOT TESTED | needs real accounts |
| Temporal workflows (Review Action, plans, indexing) | NOT TESTED | no Temporal in the sandbox |

## Findings

1. **Fixed:** Insight showed engineering text ("Temporal", "InsightActionWorkflow") to the customer. Test: `apps/dashboard/app/api/insight/__tests__/review-action-unavailable.test.ts` failed before, passes after.
2. **Open, same kind:** other messages still name Temporal to the customer: `app/api/ask-ai/execute/route.ts` (plan cannot run), `app/api/brain/upload/route.ts` and `app/api/brain/reindex/route.ts` ("Temporal is unavailable, so indexing has not started yet"). Not changed here; recommended before launch.
3. **Open:** a held customer message shows in Conversations and Work Items but not on Approvals or Home (see the proof page).
4. **Open (wording):** Billing says "Price not set yet/period" and "7 payment settings", and the sweep's error-text pattern did not catch the Insight text, so a screen can pass that check and still show internal names. The sweep pattern should list internal names too.
