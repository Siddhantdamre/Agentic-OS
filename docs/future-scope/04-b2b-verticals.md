# 04 — B2B verticals Darex will cover

This is the industry map. Each vertical is a **pack** (`03-industry-operating-system.md`),
not a product fork. Depth order is in `13-phased-roadmap.md`. Real estate
has its own deep document (`05`). This file is the catalog of **all**
intended B2B worlds so we do not accidentally design a realtor-only OS.

---

## 1. How to read a vertical card

Every card below uses the same template:

- **Who pays** — the org type.
- **Jobs-to-be-done** — what the brain must do daily.
- **Primary entities** — namespaced types.
- **Must-have integrations** — see also `06`.
- **Must-have sources** — see also `07`.
- **Employees to seed**.
- **Confirm classes extra**.
- **Out of scope** — so we do not play doctor/lawyer/bank.
- **Wave** — when we build it (W0 core, W1 real estate, W2–W5 later).

If a vertical is Wave 4+, the card is still required: connector and
source catalogs must not omit them, or we will paint ourselves into a
HubSpot-only architecture.

---

## 2. Wave 0 — Core B2B (every org)

**Who pays:** Any SMB/mid-market with email, chat, a spreadsheet, and a
pipeline.

**Jobs:** Answer customers, draft follow-ups, book meetings, query
numbers, keep a knowledge base, escalate.

**Entities:** `contact`, `company`, `deal`, `ticket`, `document`, `event`.

**Integrations:** Gmail, Calendar, WhatsApp, Drive/Docs/Sheets, HubSpot
(or later Salesforce/Zoho), Slack, Stripe/Razorpay, web_search.

**Sources:** Inbox history, Drive, Notion, website crawl (owner-approved),
SQL.

**Employees:** Sarah (sales), Emma (support), Marcus (ops).

**Confirm extra:** `send`, `pay`.

**Out of scope:** None beyond kernel non-goals.

**Wave:** Already partially live.

---

## 3. Wave 1 — Real estate (see `05` for full design)

Four packs, one industry:

| Pack id | Who |
|---------|-----|
| `real-estate-brokerage` | Residential / mixed sales brokerages |
| `real-estate-pm` | Property managers / HOA / rental ops |
| `real-estate-cre` | Commercial brokers, tenant-rep, landlord-rep |
| `real-estate-developer` | Builders, townships, pre-sales CRMs |

Markets: **India first** (RERA, 99acres/MagicBricks/Housing-class,
WhatsApp-heavy), **US second** (MLS/IDX, NAR/fair housing, Follow Up
Boss / kvCORE), then UAE/UK/AU adapters.

This is the first *deep* vertical because: WhatsApp + Gmail + Calendar
already match how brokers work; listings are a natural “asset memory”;
confirm-before-send is mandatory for offers and ads; and the original
product thesis (“AI employees”) maps cleanly onto listing coordinator /
buyer agent / leasing coordinator.

Details: `05-real-estate-vertical.md`.

---

## 4. Wave 2 — Agencies, professional services, e-commerce, SaaS GTM

### 4.1 Agencies (`agencies`)

**Who pays:** Performance, creative, SEO, social, PR, and “full service”
agencies.

**Jobs:** Intake briefs, status reports, ads pacing, creative asset
search, client Slack/WhatsApp updates, invoice chase, retainers.

**Entities:** `ag.client`, `ag.retainer`, `ag.campaign`, `ag.brief`,
`ag.asset`.

**Integrations:** Google Ads, Meta Ads (already in catalog), GA4 (stub
today — must become real), Search Console (stub), HubSpot, Slack,
Notion, Drive, Figma (read comments / file links), Shopify (for
e-comm clients), QuickBooks/Xero, Asana/Monday/ClickUp.

**Sources:** Ads APIs, GA4, GSC, brand guidelines in Drive, call
recordings (optional).

**Employees:** Account manager, Media buyer, Reporting analyst,
Creative ops.

**Confirm extra:** `publish` (ads), `pay` (client media not Darex’s
problem — still confirm spend changes).

**Out of scope:** Generating ads that violate platform policies;
guaranteeing ROAS.

### 4.2 Professional services (`prof-services`)

**Who pays:** Consultancies, CA/CPA firms (ops, not tax advice as
license), design studios, boutique law *intake* (not legal advice).

**Jobs:** Lead intake, proposal drafts from past winners, scheduling,
time/expense capture, document assembly, reminder cadences.

**Entities:** `ps.engagement`, `ps.proposal`, `ps.deliverable`,
`ps.time_entry`.

**Integrations:** Gmail, Calendar, Docs, PandaDoc/DocuSign, Harvest/
Toggl, QuickBooks, Clio or PracticePanther (later, legal-ops only).

**Employees:** Intake, Delivery coordinator, Billing assistant.

**Confirm extra:** `sign`, `send` (anything that looks like advice).
**Hard rule:** model must not present as a licensed professional.

### 4.3 E-commerce / D2C (`ecommerce`)

**Who pays:** Shopify/Woo/custom store brands, not marketplaces
themselves.

**Jobs:** Order “where is my order”, returns policy, inventory asks,
subscription issues, review replies, restock alerts to owner.

**Entities:** `ecom.order`, `ecom.sku`, `ecom.subscription`,
`ecom.return`.

**Integrations:** Shopify (already), WooCommerce, Shiprocket/Delhivery/
EasyPost, Gorgias/Zendesk, Klaviyo/Mailchimp, Stripe, Razorpay,
Google/Meta ads, GA4, reviews (Judge.me, Stamped).

**Employees:** CX, Ops, Retention.

**Confirm extra:** `pay` (refunds), `write_sor` (order edits).

**Out of scope:** Warehouse robotics; being the storefront.

Skill file `ecommerce/SKILL.md` already exists — **mount it**.

### 4.4 SaaS GTM (`saas-gtm`)

**Who pays:** B2B software companies using Darex as their GTM brain
(sales + CS + support), possibly dogfooding Darex itself.

**Jobs:** Inbound demo qualify, product-qualified lead routing, CS
health, churn risk, support deflection from docs, changelog to
customers.

**Entities:** `saas.account`, `saas.subscription`, `saas.ticket`,
`saas.opportunity`.

**Integrations:** HubSpot/Salesforce, Stripe, Intercom/Zendesk
(already), Slack, Linear/Jira, GitHub (already), Mixpanel/PostHog,
Notion docs, Productboard (later).

**Employees:** SDR, AE assist, CSM, Support.

**Confirm extra:** `pay` (credits), `write_sor` (entitlement changes).

---

## 5. Wave 3 — Wholesale, recruiting, hospitality ops

### 5.1 Wholesale / distribution (`wholesale`)

**Who pays:** Distributors, B2B traders, manufacturers’ sales orgs.

**Jobs:** Quote from price list, stock check, PO chase, GST invoice
status, beat plan for salespeople, WhatsApp dealer groups.

**Entities:** `wh.sku`, `wh.price_list`, `wh.quote`, `wh.po`,
`wh.dealer`.

**Integrations:** Tally/Zoho Books/QuickBooks, Shopify wholesale or
custom ERP (Unicommerce, Vinculum), WhatsApp, Sheets (many still live
here), Razorpay/Stripe.

**Sources:** Price lists, GSTN e-invoice (read, India), inventory CSV.

**Employees:** Inside sales, Credit controller (confirm on credit
limit), Dispatch coordinator.

**Confirm extra:** `pay`, `write_sor` (credit, pricing exceptions).

**Out of scope:** Being an ERP. Darex talks *to* Tally/Zoho; it does
not replace them.

### 5.2 Recruiting / staffing (`recruiting`)

**Who pays:** Agencies and in-house talent teams.

**Jobs:** Parse inbound WhatsApp/email CVs, match to reqs, schedule,
reject politely, submit to client ATS.

**Entities:** `rec.req`, `rec.candidate`, `rec.submission`,
`rec.interview`.

**Integrations:** Greenhouse, Lever, Ashby, Workable, LinkedIn (limited
API — honest about what we cannot scrape), Gmail, Calendar, WhatsApp,
Zoom/Meet.

**Employees:** Sourcer, Coordinator, Client reporter.

**Confirm extra:** `send` (offers), `write_sor` (reject in ATS).

**Out of scope:** Discriminatory screening; scraping LinkedIn against
ToS. Compliance pack: EEO / Indian labour notices as configured.

### 5.3 Hospitality ops (`hospitality`)

**Who pays:** Independent hotels, restaurant groups, boutique stays —
not global chains’ PMS replacements.

**Jobs:** Reservation WhatsApp, upsell, review reply, staff shift
questions, vendor invoices.

**Entities:** `hos.reservation`, `hos.guest`, `hos.room`, `hos.review`.

**Integrations:** Cloudbeds/Mews (later), Google Business Profile,
WhatsApp, Instagram, Stripe, reviews (Google, TripAdvisor where API
exists).

**Confirm extra:** `pay` (refunds), `publish` (public replies).

---

## 6. Wave 4 — Construction, education ops, clinic ops, insurance brokerage

Heavier compliance and messier SoRs. Packs are designed now so
connectors in `06` include them; implementation waits.

### 6.1 Construction / contractors (`construction`)

**Jobs:** Bid intake, RFI chase, site WhatsApp groups summary to owner,
subcontractor certificates expiry, invoice against PO.

**Entities:** `con.project`, `con.rfi`, `con.sub`, `con.change_order`.

**Integrations:** Procore/Autodesk (later), Drive, WhatsApp, Sheets,
QuickBooks.

**Out of scope:** Structural calculations; safety sign-off as AI.

### 6.2 Education ops (`education`)

**Jobs:** Admissions WhatsApp, fee reminders, timetable questions,
parent updates.

**Entities:** `edu.lead`, `edu.student` (minimize PII), `edu.fee`.

**Integrations:** WhatsApp, Gmail, Razorpay, Google Classroom (careful
with minors — **no child-directed sexual content, ever**; student data
minimization; parental consent flags).

**Hard rule:** If the org serves minors, extra retention + access
controls; employees never generate romantic/sexual content involving
minors (illegal; stop).

### 6.3 Clinic / dental / veterinary **ops** (`clinic-ops`)

**Jobs:** Appointment WhatsApp, no-show reminders, billing, inventory
of supplies — **not diagnosis**.

**Entities:** `cl.appointment`, `cl.patient_ref` (tokenized),
`cl.invoice`.

**Integrations:** Calendar, WhatsApp, Razorpay/Stripe, a PMS if they
have an API (Practo-class later).

**Out of scope:** Clinical advice, prescribing, imaging interpretation.
PHI/EHR: default **do not store clinical notes in Darex memory**; store
pointers. Compliance pack required before sales.

### 6.4 Insurance brokerage (`insurance-broker`)

**Jobs:** Quote gather, renewal reminders, claim *status* chase, not
underwriting.

**Entities:** `ins.policy`, `ins.renewal`, `ins.claim_status`.

**Out of scope:** Binding coverage as the AI; misrepresenting products.

---

## 7. Wave 5 — Adjacent B2B that we will only enter with a pack review

These are listed so the OS data model does not forbid them:

- **Automotive dealers** — inventory + WhatsApp test-drive (similar to
  real estate showings).
- **Logistics brokers** — tracking + exception WhatsApp (not a TMS).
- **Internal corporate “AI employee”** — Darex sold as the company
  brain for a non-customer-facing ops team (IT, HR ops, finance ops).
- **Franchise / multi-location retail** — GBP + reviews + local
  inventory (overlaps e-com + hospitality).
- **Non-profits / associations** — donations + member WhatsApp
  (Stripe, Mailchimp).

Each needs a one-page pack RFC before code.

---

## 8. Shared patterns across all B2B (do not re-invent per pack)

| Pattern | Used by |
|---------|---------|
| Lead → qualify → book → follow up | Brokerage, SaaS, agencies, clinics-ops, education |
| Ticket → retrieve SOP → reply / escalate | All |
| Asset record + public Q&A | Listings, SKUs, rooms, courses |
| Document assemble + e-sign | Offers, proposals, leases, MSAs |
| Money movement with confirm | Refunds, invoices, deposits (never escrow) |
| Review / reputation reply | GBP, portals, TripAdvisor |
| Scheduled owner briefing | All |
| Human takeover inbox | All |

If you are about to add a workflow that is not a specialization of one
of these, stop and check you are not building a second OS.

---

## 9. Geographic overlay (not a vertical, but a pack module)

Vertical packs take `markets: []`. Market modules add:

| Market | Extras |
|--------|--------|
| IN | WhatsApp-first, Razorpay, GST/Tally, RERA, DPDP, 99acres-class, Exotel |
| US | SMS + email, Stripe, MLS/IDX, fair housing, DocuSign, Follow Up Boss |
| GB | GDPR, Rightmove/Zoopla *if* licensed, Stripe |
| AE | WhatsApp, Bayut/Dubizzle *if* licensed, multi-currency |
| AU | Domain/REA *if* licensed |

Never scrape a portal because a market “expects” it. Licensed feed,
official API, or owner CSV/export only.

---

## 10. What we will not productize as verticals

- Consumer-only social apps.
- High-frequency trading / unlicensed investment advice.
- Political campaign ops.
- Adult content businesses (policy).
- Anything whose core loop is harming people or evading law.

The Brain OS is for **operating a legitimate B2B (or B2B2C) company**.
Real estate is in. “All B2B” is the ambition. The waves are the honesty.

---

## 11. Alternatives in the world (instead of “many vertical packs”)

**What Darex does:** one OS, many packs, waves W0–W5. Do not ship 12
industries in year one.

| # | Alternative | Why it can be better | Why we still do ours | Refs |
|---|-------------|----------------------|----------------------|------|
| 1 | **Point-solution AI per vertical** (Harvey legal, Sierra CX, 11x SDR, Artisan BDR, Devin eng) | Depth and pricing; buyers understand “AI lawyer / AI SDR” | We are the *platform* those become as packs; Harvey is licensed-advice (our non-goal) | Vellum “best AI employees”; CellCog comparison 2026 |
| 2 | **Industry ERPs only** (Yardi, AppFolio, Procore, Cloudbeds, Greenhouse) | They already *are* the SoR | We connect; we do not rebuild Yardi | Catalog in `06` |
| 3 | **HubSpot / Salesforce as the only world** | One CRM, less catalog | IN brokers live on WhatsApp + Sheets; US RE on FUB/kvCORE | `06` CRM table |
| 4 | **n8n / Zapier industry templates** | Thousands of community workflows | No tenancy, no confirm, no memory — n8n lives in `06`, not here | `06` GitHub list |
| 5 | **Medusa / Saleor** for ecom instead of an ecom pack | Real commerce OSS | Shopify/Woo stay SoR; pack is CX + ops on top | This file GitHub list |

**Five things to steal anyway**

1. Harvey: disclosure + “not licensed advice” in every professional pack (`12`).
2. Sierra: channel quality bar for Emma-class support.
3. 11x/Artisan: SARAH allowlist + confirm on send; do not spray.
4. AppFolio/Yardi: PM pack entities copied from *their* objects, not invented.
5. Wave order stays; skip Wave 4 before skipping Phase 6 (`13`).

### Open-source GitHub — this file only (industry products)

Odoo / Twenty / SuiteCRM → `03`. Cal.com → `05`. Chatwoot → `11`. OpenHands → `00`. n8n → `06`.

| Repo | Similar to | We take |
|------|------------|---------|
| [medusajs/medusa](https://github.com/medusajs/medusa) | Ecom OS (orders, carts) | Ecom pack entities; Shopify stays SoR |
| [saleor/saleor](https://github.com/saleor/saleor) | GraphQL commerce | Same |
| [woocommerce/woocommerce](https://github.com/woocommerce/woocommerce) | WordPress commerce | Woo connector objects |
| [magento/magento2](https://github.com/magento/magento2) | Enterprise commerce | Wholesale pack later |
| [posthog/posthog](https://github.com/PostHog/posthog) | Product analytics OSS | SaaS pack metrics; not Insight engine |
| [outline/outline](https://github.com/outline/outline) | Team wiki | KB ingest for agencies/SaaS |
| [strapi/strapi](https://github.com/strapi/strapi) | Headless CMS | Agency content pack |
| [TryGhost/Ghost](https://github.com/TryGhost/Ghost) | Publishing | Content-ops pack |
| [moodle/moodle](https://github.com/moodle/moodle) | LMS | Education pack entities |
| [openemr/openemr](https://github.com/openemr/openemr) | Clinic EMR | Clinic-ops *entities only*; PHI in `12` |
| [makeplane/plane](https://github.com/makeplane/plane) | Jira-class OSS | Professional-services work items |
| [listmonk/listmonk](https://github.com/knadh/listmonk) | Self-host campaigns | Marketing pack; Klaviyo stays SoR |
| [plausible/analytics](https://github.com/plausible/analytics) | Privacy analytics | SaaS pack KPI, not GA4 replace |
| [umami-software/umami](https://github.com/umami-software/umami) | Same | Same |
| [pretix/pretix](https://github.com/pretix/pretix) | Ticketing / events | Hospitality-adjacent pack |
