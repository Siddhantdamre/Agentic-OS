# Use cases and the 8 shipped roles

xAI ships eight starter roles. Every example prompt ends with a "do not send /
do not change" clause: the intended pattern is **draft-first, review-then-act**.

| Role | Owns | Typical connections |
|---|---|---|
| Sales Outbound | Account research, contact prioritisation, review-ready outreach | CRM, intent sources, company sites, email, LinkedIn |
| Talent Scout | Sourcing, candidate research, outreach drafts, scheduling prep | ATS, sourcing tools, email, calendar |
| Paid Media | Campaign monitoring, budget recommendations | Ad platforms, analytics, budget sheet, Slack |
| Expense Manager | Weekly reconciliation, missing-info follow-ups | Expense system, email, shared drive, finance sheets |
| Product Performance | Evidence-backed performance investigations | Observability, analytics, incident tools, source control links |
| Bug Reproduction | Turning reports into reliable repro packs | Issue tracker, staging, browser, network tools |
| Account Health | Risk and expansion signals across customers | CRM, usage, support, billing, CS notes |
| Chief of Staff | Source-linked digest of what changed and what needs a decision | Slack, email, calendar, meeting notes, planning docs |

## Example prompts (from docs)

- **Sales Outbound:** research 25 CRM accounts, score against ICP and intent, find
  up to 3 contacts each, draft email and LinkedIn outreach, skip anyone already in
  a sequence, return a review list, do not send or enroll.
- **Talent Scout:** find 20 candidates for a role, exclude anyone already in the
  ATS, explain evidence per match, draft outreach in my voice, do not contact.
- **Paid Media:** pull spend and performance per campaign, compare with budget
  and target CAC, recommend reallocations, draft a Slack update, change nothing.
- **Expense Manager:** build the weekly summary against policy, match receipts,
  flag exceptions, draft one follow-up per owner, do not send or reimburse.
- **Product Performance:** investigate a checkout latency rise since yesterday's
  release from dashboards, traces and flamegraphs; separate facts from hypotheses.
- **Bug Reproduction:** reproduce in staging with a fresh test account; return
  steps, expected vs actual, screenshots, browser/OS, console notes, minimal test.
- **Account Health:** ranked watch list combining usage, escalations, renewal
  timing and stakeholder activity, with a suggested next step each.
- **Chief of Staff:** daily digest limited to items mapping to stated priorities,
  each with source, why it matters, next step, and whether a decision is owed.

## How xAI uses it internally

Sales research and outbound drafting, demo environment prep, CRM and org-chart
upkeep, invoice processing from email, bug reproduction before ticket filing.

## Other documented uses

Sales outbound, pipeline ops, account follow-up, marketing campaigns, office
operations, bug fixes, CRM management, expense processing. Third-party guides add
competitive-intelligence swarms, repo audits, multi-agent research pipelines and
parallel scenario planning.

## Best and worst fits (reviewer view)

- **Good:** legacy systems with no API; internal reversible work (expense
  categorisation, research drafts, pipeline hygiene); overnight jobs that produce
  a review list.
- **Poor:** live customer support queues, financial transactions, regulated data,
  anything needing per-action audit trails. No support-specific role ships, despite
  a "sign in to Zendesk" demo.
