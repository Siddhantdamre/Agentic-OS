# RFC — Wave 2–4 packs (P5 / P6)

**Skip / RFC only.** Do not install as live packs. Clinic-ops default no PHI.
Education minors controls are a compliance review (`12`) before Wave 4 sales.

| Pack id | Wave | Status | Note |
|---------|------|--------|------|
| agencies | 2 | RFC | Recommend on onboarding; quality bar not met |
| saas-gtm | 2 | RFC | |
| ecommerce | 2 | RFC | SKILL.md exists; not a pack |
| prof-services | 2 | RFC | Must disclose “not licensed advice” before live |
| wholesale | 3 | RFC | |
| recruiting | 3 | RFC | |
| hospitality | 3 | RFC | |
| clinic-ops | 4 | **out** | No PHI in Darex |
| education | 4 | RFC | Minors controls before sales |

Onboarding may still *recommend* Wave 2 ids. `POST /api/packs` refuses
`live: false` catalog rows so we do not ship a pack that fails `03` §11.
