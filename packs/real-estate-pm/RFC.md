# RFC — real-estate-pm (P4 remainder / P6-adjacent)

Not live. Clinic-ops and PHI are **out**.

## In scope later

- `pm.unit`, `pm.lease`, `pm.work_order`, `pm.charge` (charge table exists for the close gate)
- AppFolio / Buildium / Sheets PM
- Emergency leak routing (golden #6 in `05` §11)

## Already implemented (cheap P4)

`RentReminderWorkflow` + `pm_charges` close gate: tenant “I paid” sets
`claimed_paid_at` only. Close requires `psp_payment_id` from a PSP webhook
or `closed_reason = human_confirm`.
