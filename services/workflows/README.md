# services/workflows — Temporal Workflow Definitions (Phase 5)

Durable conversation workflows and activity definitions. All external side-effects live here.

**Status:** Placeholder. Populated in **Phase 5**.

## What goes here
```
services/workflows/
  src/
    workflows/
      ConversationWorkflow.ts   → per-thread workflow (not per-message)
      ProvisioningWorkflow.ts   → org provisioning on sign-up
      InsightWorkflow.ts        → scheduled analytics batch (Phase 7)
    activities/
      chatwoot.ts    → post message to Chatwoot (idempotent)
      crm.ts         → HubSpot write (idempotent)
      calendar.ts    → Google Calendar booking (idempotent)
      payments.ts    → Razorpay charge (idempotent)
      email.ts       → send email (idempotent)
    worker.ts        → Temporal worker registering all activities
  package.json
  tsconfig.json
```

## Design Constraint (from spec Rule 5)
> Every external side-effect (sending a message, writing to a CRM, charging a payment, booking a calendar slot) must be implemented as an **idempotent Temporal Activity**, not a bare API call.

Every activity uses the `idempotency_keys` table to ensure exactly-once semantics even if retried by Temporal.
