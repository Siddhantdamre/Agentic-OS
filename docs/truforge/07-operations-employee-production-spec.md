# Operations Employee — Production Specification & Operating Model

> **Reference:** [`docs/new-109-pg-plan/DareXAI One_ Employee Blueprint.md`](file:///Users/addy/Coding/SaaS/Agentic-Os-SaaS/docs/new-109-pg-plan/DareXAI%20One_%20Employee%20Blueprint.md) (Pages 62–98)  
> **Core Philosophy:** The Operations Employee is not a reporting script or dashboard viewer. It is the operational backbone of the business: maintaining state, running the Expected vs. Actual discrepancy engine, executing morning operational runs, reconciling cross-system billing, detecting stuck work, and explaining both actions taken and reasons for non-action.

---

## 1. Operating Architecture & Discrepancy Engine

The fundamental principle governing the Operations Employee is **Expected vs. Actual**:
```text
               BUSINESS OPERATIONS STREAM
                           ↓
             OPERATIONS EMPLOYEE REASONING
                           ↓
        ┌──────────────────┴──────────────────┐
        ↓                                     ↓
  EXPECTED STATE                        ACTUAL STATE
  (What SHOULD happen per               (What HAS actually happened
   SLA, contract, or policy)             in CRM, Stripe, or DB)
        └──────────────────┬──────────────────┘
                           ↓
                  DISCREPANCY ENGINE
                           ↓
              ┌────────────┴────────────┐
              ↓                         ↓
      NO DISCREPANCY              DISCREPANCY FOUND
      (System healthy;             (Action required: SLA breached,
       silently logged)            payment stuck, deal orphaned)
                                        ↓
                                DECISION & ACTION
                                (Auto-fix or alert in
                                 Needs Attention queue)
```

---

## 2. Declarative Agent Specification (`trueforge/data/agents/operations-employee.json`)

```json
{
  "name": "operations-employee",
  "description": "Autonomous Operations Employee: executes morning operations run, reconciles billing across Stripe and QuickBooks, detects stuck work, and prepares executive briefings.",
  "model": {
    "name": "claude-3-7-sonnet",
    "parameters": {
      "temperature": 0.1,
      "max_tokens": 4096,
      "top_p": 0.95,
      "reasoning_effort": "high"
    }
  },
  "instructions": "You are David, the Darex Operations Employee. Your duty is operational integrity.\n\nCORE OPERATING MANDATES:\n1. EXPECTED VS ACTUAL: Constantly audit what was supposed to happen against what actually occurred.\n2. MORNING RUN (8 AM): Ingest overnight inquiries, deduplicate entities, verify SLAs, and produce the Daily Snapshot.\n3. RECONCILIATION: Reconcile financial records using Python in the sandbox (Code Mode) to prevent hallucinated math.\n4. STUCK WORK: Identify tasks waiting > 24 hours and escalate via the Needs Attention queue.\n5. EXPLAIN BOTH ACTION AND NON-ACTION: In every audit log, explain why you executed an action and why you explicitly chose NOT to act on others.",
  "mcp_servers": [
    {
      "name": "darex-connectors",
      "preload": false,
      "preload_tools": [
        "db_query",
        "calendar_list_events",
        "quickbooks_get_invoices"
      ],
      "enable_tools": [
        "@all"
      ],
      "require_approval_for_tools": [
        "@destructive",
        "quickbooks_create_invoice",
        "stripe_issue_refund"
      ]
    }
  ],
  "skills": [
    { "name": "morning-operations-run" },
    { "name": "billing-reconciliation" },
    { "name": "meeting-dossier-prep" }
  ],
  "config": {
    "sandbox": {
      "enabled": true,
      "allow_file_downloads": true
    },
    "dynamic_sub_agents": {
      "enabled": true
    },
    "ask_user_questions": {
      "enabled": true
    },
    "generative_ui": {
      "enabled": true
    },
    "context_management": {
      "compaction": {
        "enabled": true,
        "trigger": { "type": "input_tokens", "value": 60000 }
      },
      "large_tool_response": {
        "enabled": true,
        "per_response_token_threshold": 6000,
        "combined_response_token_threshold": 10000,
        "preview_characters": 100
      }
    },
    "iteration_limit": 100
  }
}
```

---

## 3. Deep Operational Workflows

### Workflow 1: The 8:00 AM Morning Operations Run
Configured via TrueForge Cron:
```yaml
# Scheduled via POST /api/v1/schedules
name: "morning-operations-run"
cron: "0 8 * * *"
timezone: "Asia/Kolkata"
agent_name: "operations-employee"
payload:
  content: "Execute the Daily Morning Operations Run: pull all overnight enquiries (WhatsApp, Email, Forms), deduplicate entities, verify SLA compliance, compile today's meeting dossiers, and generate the Daily Snapshot."
```

#### Step 1: Ingestion & Deduplication Algorithm
1. The agent queries all inquiries received in the last 24 hours:
   ```sql
   SELECT id, full_name, email, phone, company, channel, message, created_at
   FROM inquiries
   WHERE org_id = current_setting('app.current_org_id')::UUID
     AND created_at >= NOW() - INTERVAL '24 hours';
   ```
2. The agent calls `mcp.darex.entity_resolve` which utilizes `022_entity_graph.sql`:
   - Normalizes phone numbers (E.164: `+919876543210`).
   - Normalizes email domains (`user@acmecorp.com` -> `acmecorp.com`).
   - Identifies duplicates where a user submitted a website inquiry at 11 PM and followed up via WhatsApp at 7 AM.
   - Merges records non-destructively: links both identifiers to a single `entity_id` and records duplicate references.

#### Step 2: SLA Verification
Checks expected next action:
- Was an automated reply dispatched within 15 minutes?
- Did a sales rep claim the lead?
- Is any inquiry older than 4 hours without an assigned owner?

#### Step 3: Executive Daily Snapshot via OpenUI
The Operations Employee pushes an interactive morning briefing to the Home Dashboard:

```text
````openui
Stack([
  Card([
    CardHeader("Daily Operations Snapshot — September 16, 2026", "Automated Morning Briefing • 8:00 AM"),
    Stack([
      Callout("28 Overnight Enquiries Processed • 26 Synced Cleanly • 2 Need Attention", variant="info"),
      Callout("1 SLA Breach: Inquiry #9412 from DataCorp unassigned for 6 hours", variant="warning")
    ], direction="horizontal", gap="sm"),
    Separator("horizontal"),
    HorizontalBarChart([
      BarItem("Inquiries Synced", 26, "#10b981"),
      BarItem("Existing Customer Follow-ups", 8, "#3b82f6"),
      BarItem("SLA Breaches", 1, "#ef4444"),
      BarItem("Calendar Meetings Today", 4, "#8b5cf6")
    ]),
    Separator("horizontal"),
    CardHeader("Action Items for Today", "High-priority items identified by the Discrepancy Engine"),
    Steps([
      StepsItem("Assign DataCorp Deal", "Deal size $30,000; unassigned since 2 AM"),
      StepsItem("Review QuickBooks Invoice #4092", "Stripe payment succeeded, QuickBooks ledger pending sync"),
      StepsItem("Prep for 2:30 PM Client Call", "Meeting dossier with TechFlow VP Sales compiled")
    ]),
    Separator("horizontal"),
    Stack([
      Button("Resolve DataCorp SLA Breach", variant="primary", onClick=@ToAssistant("assign_datacorp_deal")),
      Button("Sync QuickBooks Ledger", variant="secondary", onClick=@ToAssistant("sync_quickbooks_invoice")),
      Button("View Full Meeting Dossiers", variant="outline", onClick=@ToAssistant("view_meeting_dossiers"))
    ], direction="horizontal", gap="sm")
  ])
], direction="vertical", gap="md")
````
```

---

### Workflow 2: Cross-System Billing Reconciliation (Code Mode)
When reconciling Stripe charges against QuickBooks invoices, doing math in LLM prose leads to errors. The Operations Employee executes a Python script in the Daytona sandbox:

```python
# Executed in Daytona Sandbox
import pandas as pd
import json

# 1. Load Stripe charges and QuickBooks invoices
with open('/tmp/stripe_charges_aug.json') as f:
    stripe_data = json.load(f)
with open('/tmp/quickbooks_invoices_aug.json') as f:
    qb_data = json.load(f)

df_stripe = pd.DataFrame(stripe_data)
df_qb = pd.DataFrame(qb_data)

# 2. Join on customer email or metadata invoice_id
merged = pd.merge(df_stripe, df_qb, on='invoice_id', how='outer', suffixes=('_stripe', '_qb'))

# 3. Identify discrepancies
unpaid_qb = merged[merged['status_stripe'].isna() & (merged['status_qb'] == 'Unpaid')]
unmatched_stripe = merged[merged['status_qb'].isna() & (merged['status_stripe'] == 'succeeded')]
amount_mismatch = merged[merged['amount_stripe'] != merged['amount_qb']]

print(f"Total Transactions: {len(merged)}")
print(f"Perfect Matches: {len(merged) - len(unpaid_qb) - len(unmatched_stripe) - len(amount_mismatch)}")
print(f"Unpaid QB Invoices: {len(unpaid_qb)}")
print(f"Unmatched Stripe Charges: {len(unmatched_stripe)}")
print(f"Amount Mismatches: {len(amount_mismatch)}")

# 4. Export detailed report to Excel
with pd.ExcelWriter('/tmp/reconciliation_aug_2026.xlsx') as writer:
    merged.to_excel(writer, sheet_name='All_Transactions', index=False)
    unpaid_qb.to_excel(writer, sheet_name='Unpaid_QB', index=False)
    amount_mismatch.to_excel(writer, sheet_name='Mismatches', index=False)

print("FILE_SAVED:/tmp/reconciliation_aug_2026.xlsx")
```

TrueForge intercepts `FILE_SAVED:/tmp/reconciliation_aug_2026.xlsx`, generates a cryptographically signed download token, and renders a **Download Reconciliation Report (.xlsx)** button in the chat.

---

### Workflow 3: Meeting Preparation Dossiers
Every evening at 8:00 PM, the Operations Employee prepares dossiers for tomorrow's meetings:
1. Queries Google Calendar via `calendar_list_events({ time_min: tomorrow_start, time_max: tomorrow_end })`.
2. For each meeting attendee:
   - Queries CRM for active deals, deal stage, and past meeting notes.
   - Queries Gmail for the last 3 emails exchanged.
   - Queries LinkedIn/Exa for recent company news.
3. Compiles a structured executive dossier:
   ```text
   MEETING DOSSIER: TechFlow Renewal Discussion (Tomorrow 2:30 PM)
   - Attendee: Vikram Sethi (CTO, TechFlow)
   - Contract Value: $45,000/yr (Renews in 45 days)
   - Open Support Issues: 0 (All resolved)
   - Sentiment History: Positive (NPS 9 last month)
   - Objective: Secure 2-year renewal commitment with 15% seat expansion
   - Suggested Talking Point: Mention their recent platform expansion to UK
   ```

---

### Workflow 4: Explainability of Action AND Non-Action
Human operators must know why an automated employee chose NOT to act on a customer. In every turn, the Operations Employee reports its evaluation tree:

```text
````openui
Accordion([
  AccordionItem("Execution Audit & Decision Rationale", [
    Table([
      Column("Target Entity", "entity"),
      Column("Evaluated Rule", "rule"),
      Column("Decision", "decision"),
      Column("Reasoning", "reasoning")
    ], data=[
      {"entity": "Apex Logistics (Deal #891)", "rule": "Send Payment Reminder", "decision": "SKIPPED", "reasoning": "Payment was received via wire transfer 1.5 hours ago."},
      {"entity": "DataCore (Inquiry #9412)", "rule": "Escalate SLA Breach", "decision": "EXECUTED", "reasoning": "Unassigned for 6 hours; exceeds 4-hour SLA limit."},
      {"entity": "Vertex Cloud", "rule": "Trigger Churn Playbook", "decision": "SKIPPED", "reasoning": "Cancellation mention was in inquiry about another customer; not an account churn signal."}
    ])
  ])
])
````
```
