# Real estate brokerage — India wedge (v1)

Pack id: `real-estate-brokerage`. Directory: `packs/re-brokerage-in/`.
Extends Core B2B. Markets documented in `MARKETS.md` (IN documented, US documented).
`pack.yaml` **`live: false`** until §11 live-verify is green on a migrated DB
and a Calendar-connected showing is booked from the listings UI.

## Quality bar (`03` §11)

1. Idempotent install (re-install is a no-op).
2. Three employees with distinct allowlists: Aisha (ISA), Kabir (showings), Meera (listings).
3. Five golden conversations in `goldens/` + `infra/evals/re-brokerage.yaml`.
4. Disconnected Sheets/Calendar → `notConnected` + `/connectors`.
5. Two durable workflows: `ShowingScheduleWorkflow`, `RentReminderWorkflow`
   (started from `/listings` and `/inquiries` UI, not YAML-only).
6. Memory write-back stores `re.listing` / `re.inquiry` entity facts.
7. Compliance validator catches the known-bad fair-housing draft.
8. This README + connector list + what we never invent.

## How to run goldens

```bash
node infra/evals/runner.js re-brokerage.yaml
# or the full suite:
node infra/evals/runner.js
bash infra/scripts/run-evals.sh
```

Fixture cases always run (matcher + compliance + Calendar `notConnected`).
`re-listings-search-live` / `re-listings-zero-live` seed `re_listings` under two
orgs and query as `darex_app` + RLS. They **skip** only if Postgres is
unreachable; missing `015_packs.sql` **fails**.

Remaining operator live-verify (does not flip `live: true` until done):

1. Migrated DB with `015_packs.sql`; live listing evals `[PASS]` not `[SKIP]`.
2. Connect Google Calendar on `/connectors`; book a showing from `/listings` or
   `/inquiries`; confirm a real Calendar event (not a handwritten success).
3. Disconnect Calendar; the same UI path returns `connected: false` + `/connectors`.
4. Ask AI / `re.listings_search` “2BHK in X under Y” returns only projection rows.

## Inventory SoR

Google Sheets / CSV is first-class. Licensed MLS is later and only with
credentials. **Never scrape portals. Never build an MLS.**

Search: structured filters first (BHK, locality, budget). Zero matches
returns an empty list — never pad with fake units.

## Connectors (recommended, never marked connected)

| Connector | Why |
|-----------|-----|
| google-sheets | Inventory SoR |
| whatsapp | Inbound inquiries |
| gmail | Portal lead email parse (org inbox, not a scrape) |
| google-calendar | Showing slots |

## What we never invent

- Listing ids, prices, RERA numbers, area, availability
- “Payment received” without a PSP webhook (`psp_payment_id`)
- Booked calendar slots when Calendar is disconnected
- Steering by protected class (US fair housing / IN ad rules)

## Uninstall

Disables pack UI and schedules. **Does not delete conversations.**
