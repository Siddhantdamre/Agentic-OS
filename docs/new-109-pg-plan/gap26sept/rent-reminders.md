# Rent Reminders Audit

## Status: working (lease/charge ingest APIs, real outbound reminder via connector tools, rent-payment webhook; fraud close gate preserved)

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | No lease / charge ingestion API | P0 | `rent-reminders/leases`, `rent-reminders/charges` | 🟢 Done | POST inserts into pm_leases / pm_charges scoped by session org. |
| 2 | rentReminderActivity send-side no-op | P0 | `services/workflows/src/activities/packs.ts` | 🟢 Done | Dispatches WhatsApp/Twilio/Gmail via tool executor; honest not-connected. |
| 3 | Missing tenant rent PSP webhook | P0 | `webhooks/rent-payment/route.ts` | 🟢 Done | Stripe/Razorpay signature → FOR UPDATE close with psp_payment_id. |
| 4 | Fraud-proof charge close gate | — | rent-reminders route + 015_packs | 🟢 Done | Pre-existing; UI still cannot fake close. |

The rent reminder subsystem now has operator ingest paths, real multi-channel reminder dispatch, and a dedicated tenant payment webhook distinct from SaaS billing.
