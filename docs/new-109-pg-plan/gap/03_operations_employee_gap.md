# 03 — Operations Employee: Comprehensive Technical Gap Analysis

> **Blueprint Target:** Tab 3 (Pages 62–98, Sections 1–44)  
> **Mandate:** *“Make sure the work gets done. Nothing important should fall through the cracks.”*  
> **Current Status Score:** 🟢 2 Built (13.3%) | 🟡 4 Partial (26.7%) | 🔴 9 Missing (60.0%)

---

## 1. Executive Summary & Core Architectural Premise

The Operations Employee has the largest technical gap in the repository today (60% missing):
- **Traditional Automation (Zapier/Make):** `Trigger → Action` (Blind, mechanical firing without verification or error handling).
- **AI Operations Employee:** `Responsibility → Context → Judgment → Action → Verification → Outcome`.
- **The Core Differentiator:** **Expected vs. Actual State Tracking**.
  A human operations employee doesn't just create a task; they check whether the task was actually done, determine whether it still matters, send reminders, and escalate if it falls behind SLA.

---

## 2. Granular 9-Workflow & Architecture Technical Audit

```text
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                       OPERATIONS EMPLOYEE AUDIT MATRIX                      │
 ├────┬───────────────────────────────────────┬────────┬───────────────────────┤
 │ #  │ Blueprint Workflow / Capability       │ Status │ Codebase Reality      │
 ├────┼───────────────────────────────────────┼────────┼───────────────────────┤
 │ 1  │ Expected vs. Actual Discrepancy Engine│ 🔴 GAP │ No comparison model   │
 │ 2  │ "Stuck Work" Continuous Poller        │ 🔴 GAP │ No stuck work scanner │
 │ 3  │ 9:00 AM Morning 28-Enquiry Intake     │ 🟡 PART│ Webhook ingress only  │
 │ 4  │ Fuzzy Deduplication & Quarantine Queue│ 🔴 GAP │ Exact DB unique only  │
 │ 5  │ Continuous Daytime SLA Chaining Timer │ 🟡 PART│ Temporal capable      │
 │ 6  │ Multi-System Scheduling Coordination  │ 🟢 LIVE│ Calendar + CRM tools  │
 │ 7  │ Cross-System Reconciliation Auditor   │ 🔴 GAP │ Not implemented       │
 │ 8  │ Task Health & Blocker Detection       │ 🟡 PART│ work_items table live │
 │ 9  │ Meeting Prep Readiness Auditor        │ 🔴 GAP │ Not implemented       │
 │ 10 │ "What Needs Attention?" Triage Model  │ 🟡 PART│ OwnerBriefingWorkflow │
 │ 11 │ "Take Care of It" Bulk Resolution     │ 🟡 PART│ Ask AI plan executor  │
 │ 12 │ Outage Buffering & Resilient Retry    │ 🟢 LIVE│ webhook_inbox buffer  │
 │ 13 │ 4-Tier Autonomy Permission Policy     │ 🔴 GAP │ All-or-nothing union  │
 │ 14 │ Self-Explanation & Decision Ledger    │ 🔴 GAP │ No negative logging   │
 │ 15 │ V1 Daily Business Check Workflow      │ 🔴 GAP │ Not scheduled         │
 └────┴───────────────────────────────────────┴────────┴───────────────────────┘
```

---

### Deep Technical Breakdown by Capability

### 1. The "Expected vs. Actual" Discrepancy Engine
- **Blueprint Spec (Pages 65–67, 85–86):**
  - Defines the core operating loop:
    `Observe → Understand → What Should Happen (Expected) → Act → Verify (Actual) → Exception? → Fix / Escalate → Remember`.
  - Concrete Example:
    - *Expected:* Enquiry received $\to$ Lead created $\to$ Owner assigned $\to$ Customer contacted within 2 hours.
    - *Actual:* Enquiry created ✓, Owner assigned ✓, Customer contacted ✗ (2 hours elapsed).
    - *Discrepancy:* Operational exception detected $\to$ Escalate.
- **Current Codebase State (🔴 RED - MISSING):**
  - No database table or service tracks expected operational milestones.
  - The system executes commands sequentially, but has no concept of an expected completion timestamp or verification pass.
- **Required Implementation:**
  - Create table: `operational_milestones` (`id`, `org_id`, `object_type`, `object_id`, `expected_state`, `expected_by_timestamp`, `actual_state`, `status`).
  - Build `services/workflows/src/operations/expected-vs-actual-engine.ts`.

---

### 2. The "Stuck Work" Continuous Poller
- **Blueprint Spec (Pages 86–87):**
  - Continuously asks: *“What work has stopped moving in this business?”*
    - Lead has not moved pipeline stages in 7 days.
    - Customer issue has been open past target SLA.
    - Executive signature has been pending for 96 hours.
    - Tomorrow's meeting has no preparation brief.
- **Current Codebase State (🔴 RED - MISSING):**
  - `StaleChaseWorkflow.ts` exists, but only checks real estate property listings that haven't had tours.
  - No generalized multi-system stuck-work crawler exists.
- **Required Implementation:**
  - Build Temporal workflow: `StuckWorkDetectorWorkflow.ts`.
  - Runs hourly across CRM deals, open `work_items`, and calendar events; flags items exceeding dormancy thresholds.

---

### 3. Workflow 1: Morning Operation (9:00 AM Batch Multi-Channel Intake)
- **Blueprint Spec (Pages 68–73, 91–93):**
  - At 9:00 AM, the employee sweeps:
    - Website: 12 enquiries
    - WhatsApp: 8 enquiries
    - Email: 5 enquiries
    - Forms: 3 enquiries
    - **Total:** 28 enquiries
  - Evaluates each enquiry:
    - Enquiry #1 (Arjun Mehta $\to$ Enterprise $\to$ High priority $\to$ Route to sales).
    - Enquiry #2 (Priya Sharma $\to$ Existing opportunity $\to$ Update existing record, do not duplicate).
    - Enquiry #3 (Ambiguous Acme record $\to$ Quarantine for human confirmation).
    - Enquiry #4 (Missing information: *“Call me”* $\to$ Create provisional record without inventing data).
- **Current Codebase State (🟡 YELLOW):**
  - Webhooks handle individual messages as they happen, but there is **zero unified morning batch sweep**.
  - If 10 enquiries arrive overnight, no 9:00 AM cron processes them as a structured cohort.
- **Required Implementation:**
  - Build Temporal cron: `DailyMorningCheckCron.ts`.
  - Executes batch sweep across `webhook_inbox` and email IMAP / Gmail threads.

---

### 4. Fuzzy Deduplication & Ambiguous Record Handling
- **Blueprint Spec (Pages 71–73, 89):**
  - When comparing inbound *Acme Tech Solutions* against existing CRM *Acme Technologies*:
  - Checks domain, phone, address.
  - If evidence is inconclusive, **does not guess**: *“I found a possible duplicate, but I can't confidently determine whether these are the same company. Marked for review.”*
- **Current Codebase State (🔴 RED - MISSING):**
  - Database enforces strict unique constraints on email, but has no fuzzy string distance scoring (e.g. Levenshtein / trigram matching).
  - No quarantine state exists for ambiguous matches; records are either merged blindly or duplicated.
- **Required Implementation:**
  - Build `services/workflows/src/operations/dedup-engine.ts` using PostgreSQL `pg_trgm` extension.
  - Score similarity: if $0.60 \le \text{similarity} < 0.85$, insert into `ambiguous_duplicate_reviews` queue.

---

### 5. Workflow 2: Continuous Daytime Monitoring & SLA Chaining
- **Blueprint Spec (Pages 77–78):**
  - 10:14 AM: Enquiry arrives $\to$ Lead created $\to$ SLA timer initialized (2 hours).
  - 10:20 AM: Owner assigned.
  - 12:30 PM: SLA expired, no outreach $\to$ Send automated reminder to owner.
  - 2:30 PM: Still no outreach $\to$ Escalate to manager.
  - 3:00 PM: Customer replied $\to$ Auto-resolve and close monitoring loop.
- **Current Codebase State (🟡 YELLOW):**
  - Temporal supports durable timers, but no workflow currently chains reminders and escalations for lead response times.
- **Required Implementation:**
  - Build `EnquirySLAChainingWorkflow.ts`:
    ```typescript
    await workflow.sleep('2 hours');
    if (!hasBeenContacted(enquiryId)) {
      await sendInternalReminder(ownerId);
      await workflow.sleep('2 hours');
      if (!hasBeenContacted(enquiryId)) {
        await escalateToManager(managerId);
      }
    }
    ```

---

### 6. Workflow 3: Cross-System Scheduling Coordination
- **Blueprint Spec (Pages 78–79):**
  - Customer asks for demo $\to$ checks availability $\to$ books Google Calendar $\to$ updates CRM $\to$ creates prep task in task manager $\to$ sends confirmation.
- **Current Codebase State (🟢 GREEN):**
  - Calendar tools (`create_event`) and HubSpot/Zoho tools can be executed sequentially in plan execution.

---

### 7. Workflow 4: Cross-System Reconciliation Audit
- **Blueprint Spec (Pages 79–80):**
  - Scans CRM (124 leads) vs. Website Form database (129 enquiries).
  - Flags 3 missing CRM records, 2 duplicates, 1 stale record.
- **Current Codebase State (🔴 RED - MISSING):**
  - Zero cross-database reconciliation code exists.
- **Required Implementation:**
  - Build `SystemReconciliationWorkflow.ts` that compares count and IDs between `webhook_inbox` and CRM contact tables.

---

### 8. Workflow 6: Meeting Preparation Readiness Audit
- **Blueprint Spec (Pages 81–82):**
  - Scans tomorrow's meetings: detects that customer record exists, previous chats exist, but **Executive Briefing is missing**.
  - Automatically compiles customer background, open tickets, and past issues into a briefing doc before the meeting.
- **Current Codebase State (🔴 RED - MISSING):**
  - No meeting prerequisite scanner exists.
- **Required Implementation:**
  - Build `MeetingPrepWorkflow.ts` running at 6:00 PM every evening.
  - Scans calendar events for tomorrow $\to$ if no briefing doc linked $\to$ calls LLM with customer history $\to$ creates briefing doc in Google Drive.

---

### 9. Workflow 7: "What Needs Attention?" Triage Report
- **Blueprint Spec (Pages 82–83, 87, 98):**
  - Manager asks: *“What needs attention?”*
  - Returns strictly 3 high-priority exceptions:
    1. High-value enquiry: no follow-up after 3 hours.
    2. Payment reconciliation mismatch.
    3. Tomorrow's VIP meeting has an open customer ticket.
  - Confirms: *“Everything else is up to date.”* (Filters out 47 minor notifications).
- **Current Codebase State (🟡 YELLOW):**
  - `OwnerBriefingWorkflow.ts` generates a WhatsApp summary, but it summarizes raw stats rather than filtering for prioritized operational exceptions.

---

### 10. Workflow 9: System Outage Buffering & Resilient Auto-Flush
- **Blueprint Spec (Pages 84–85):**
  - If CRM API is down, employee preserves 6 new enquiries in local buffer, alerts manager, polls for recovery, and auto-syncs when CRM comes online.
- **Current Codebase State (🟢 GREEN):**
  - Built via `webhook_inbox` table and Temporal activity retries (exponential backoff).

---

### 11. 4-Tier Autonomy Permission Policy Engine
- **Blueprint Spec (Pages 87–88):**
  - **Level 1 (Observe):** Read CRM, inspect tasks (Autonomous).
  - **Level 2 (Recommend):** Recommend record merge, draft document (Human must sign off).
  - **Level 3 (Execute):** Reschedule normal meeting, assign lead (Configurable).
  - **Level 4 (Autonomous):** Send internal reminder, update standard fields (Autonomous).
  - **Strict Human Approval:** Delete records, issue refunds.
- **Current Codebase State (🔴 RED - MISSING):**
  - `tool-executor.ts` currently uses a global union of all connected tools.
  - Plan execution has an all-or-nothing approval prompt; there is no granular 4-tier autonomy policy database.
- **Required Implementation:**
  - Create table: `action_permission_tiers` (`org_id`, `action_name`, `tier: 1|2|3|4`).
  - Wire permission check into `tool-executor.ts` before dispatching any tool.

---

### 12. Self-Explanation & Negative Decision Ledger
- **Blueprint Spec (Pages 88–89, 98):**
  - User asks: *“Why did you do that?”* $\to$ *“Assigned to Priya because routing rule directs Enterprise leads to Enterprise pod.”*
  - User asks: *“Why didn't you do that?”* $\to$ *“Did not merge Acme records because email domains matched different regional subsidiaries.”*
- **Current Codebase State (🔴 RED - MISSING):**
  - Langfuse v3 logs execution traces of actions that *did* happen.
  - **No system records why an action was intentionally skipped or deferred.**
- **Required Implementation:**
  - Create table: `agent_decision_ledger` (`id`, `org_id`, `action_type`, `decision: 'executed' | 'deferred' | 'rejected'`, `reason_text`, `confidence_score`).
  - Add API route: `GET /api/agent/explain?action_id=...`.

---

## 3. Operations Employee Gap Summary

To achieve 100% parity with Tab 3 of the Blueprint, DareXAI must build:
1. **Expected vs. Actual Discrepancy Engine:** Tracking expected operational lifecycles.
2. **"Stuck Work" Continuous Detector:** Scanning for stalled leads and documents.
3. **Daily Morning Check Cron (`DailyMorningCheckCron`):** 9:00 AM batch intake & deduplication.
4. **Fuzzy Deduplication & Quarantine Queue:** Preventing bad data creation.
5. **Nightly Meeting Preparation Auditor:** Auto-generating missing executive briefs.
6. **4-Tier Autonomy Matrix:** Dynamic permissions per action.
7. **Negative Decision Trace Ledger:** Explaining *“Why didn't you do that?”*
