# Real estate brokerage — India wedge (v1)

Pack id: `real-estate-brokerage`. Directory: `packs/re-brokerage-in/`.
Extends Core B2B. Markets documented in `MARKETS.md` (IN live, US documented).

## Quality bar (`03` §11)

1. Idempotent install (re-install is a no-op).
2. Three employees with distinct allowlists: Aisha (ISA), Kabir (showings), Meera (listings).
3. Five golden conversations in `goldens/` + `infra/evals/re-brokerage.yaml`.
4. Disconnected Sheets/Calendar → `notConnected` + `/connectors`.
5. Two durable workflows: `ShowingScheduleWorkflow`, `RentReminderWorkflow`.
6. Memory write-back stores `re.listing` / `re.inquiry` entity facts.
7. Compliance validator catches the known-bad fair-housing draft.
8. This README + connector list + what we never invent.

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
