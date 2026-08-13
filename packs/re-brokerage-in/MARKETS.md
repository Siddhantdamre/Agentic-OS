# Two markets (P4 cheap)

## IN (live wedge)

WhatsApp + Gmail + Calendar + Sheets inventory. RERA public lookup is
cite-only (`tools/public/rera.ts`): URL + `retrieved_at` + TTL. Never
invent a registration number. Portal inquiries arrive as **email the org
already received** — that is not scraping 99acres/MagicBricks.

## US (documented, not a licensed MLS)

Same pack id. Follow Up Boss / RESO Web API / ShowingTime are **licensed
SoR** when the org brings credentials. Until then: Sheets inventory +
Gmail + Calendar. Fair Housing validator is on for every outbound draft.

Do not ship a US MLS feed without a license. Do not scrape Zillow.

## PM / developer

`real-estate-pm` and `real-estate-developer` stay RFC (`packs/real-estate-pm/RFC.md`).
`RentReminderWorkflow` exists so “I paid” without a PSP webhook cannot
close a `pm_charges` row. Clinic-ops / PHI is out of scope.
