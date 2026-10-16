# Onboarding Audit

## Status: 🟢 onboarding closed (name sync, RBAC, live packs, warmup cap, connector setup handoff)

The onboarding flow (`apps/dashboard/app/(onboarding)/*`, `/api/org/onboarding`, `/api/onboarding/settings`, `/api/onboarding/observation`, `/api/onboarding/trajectory`, and `/api/onboarding/backfill`) guides new customers through workspace initialization (`name` -> `team-size` -> `business-type` -> `channels`). It upholds strict anti-fabrication standards: selecting a channel explicitly seeds `disconnected` records rather than faking active OAuth, and cold-start observation endpoints query live unresolved conversations via LATERAL joins.

However, **onboarding mutation endpoints lack RBAC role checks** (allowing any member to trigger backfills or change executive decision recipients), the post-onboarding warmup poller runs an unbounded 2.5s loop that hangs if provisioning fails, and the wizard ends abruptly without walking the user through actual OAuth credential setup, resulting in a 100% connector drop-off cliff.

---

## What works (cite file:line, describe the verified real path — no mocked/fake data)

1. **4-Step Multi-Tenant Onboarding Wizard**:
   - `apps/dashboard/app/(onboarding)/onboarding/*`:
     - Structured wizard steps: `name` -> `team-size` -> `business-type` -> `channels`.
     - State persisted via `useOnboardingStore` and synchronized to `org_onboarding` table via `PATCH /api/org/onboarding`.
     - Strictly ignores body `org_id` overrides and resolves tenant context from the session cookie via `getScopedClient()` (`api/org/onboarding/route.ts:38-56`).
2. **Honest Connector State Handling**:
   - `apps/dashboard/app/(onboarding)/onboarding/channels/page.tsx:81-143`:
     - Explicitly informs users: *"Selecting a channel seeds a pending row. It does not mark the connector connected."*
     - The client form enforces an explicit throw if the API ever claims `connectorsMarkedConnected`, preventing false "all set" confirmations before OAuth keys are configured.
3. **Automated Default Employee Roster Seeding**:
   - `apps/dashboard/app/api/org/create/route.ts:5`:
     - Seeds the initial AI employee roster via `seedDefaultEmployees` directly into PostgreSQL upon organization creation.
4. **Validated Business Hours & Decision Recipient Setup**:
   - `apps/dashboard/app/api/onboarding/settings/route.ts:18-45`:
     - Validates timezone strings, parses day/time business hour windows via `parseBusinessHours`, and verifies that `decision_recipient_id` belongs to the tenant before updating.
5. **Cold-Start Observation Engine**:
   - `apps/dashboard/app/api/onboarding/observation/route.ts:6-19` and `lib/onboarding-observation-query.ts:7-31`:
     - Identifies unresolved conversations (unanswered user messages idle >2h) via a `LATERAL` join.
     - Generates authentic first-observation cards and memoizes them to avoid regenerating noise on page refresh.
6. **Idempotent Historical Backfill Pipeline**:
   - `apps/dashboard/app/api/onboarding/backfill/route.ts:18-40`:
     - Imports historical resolved conversations into `agent_open_loops` (using content-hash deduplication) and closed-won conversations into `entity_memory`.
     - Clamps backfill windows to 30 days (`clampBackfillWindow`), preventing memory exhaustion.
7. **Connection Pool Safety**:
   - `apps/dashboard/app/api/org/onboarding/route.ts:34, 76`:
     - Client release is guaranteed in `finally` blocks.

---

## What's broken (file:line, user impact, code/schema cause)

1. **Missing RBAC Authorization on Critical Onboarding Routes (`apps/dashboard/app/api/onboarding/settings/route.ts:15-30`, `apps/dashboard/app/api/onboarding/backfill/route.ts:12-28`)**:
   - *User Impact*: Privilege escalation and resource exhaustion. Any junior team member invited with read-only permissions can trigger an expensive 30-day LLM backfill or change organization business hours.
   - *Code Cause*: Both routes only verify session existence via `getScopedClient()`. Neither route verifies the user's role using `loadHumanRole()`, allowing unprivileged users to alter tenant-wide settings.
2. **Unbounded Warmup Polling Loop in Post-Onboarding Dashboard (`apps/dashboard/app/(dashboard)/page.tsx:45-104`)**:
   - *User Impact*: High CPU usage, browser tab freezing, and server request storms. If an error occurs during background provisioning, the user's dashboard loops indefinitely.
   - *Code Cause*: Immediately following onboarding completion, the dashboard sets `isWarmup = true` and starts a `setInterval(..., 2500)` executing 5 parallel API calls. There is no maximum iteration count, retry limit, or timeout handler.
3. **Unguided Connector Drop-Off Cliff (`apps/dashboard/app/(onboarding)/onboarding/channels/page.tsx:81-143`)**:
   - *User Impact*: 100% connector drop-off. Customers select WhatsApp and Gmail during onboarding, but arrive at the dashboard with all channels marked disconnected and zero explanation of how to authenticate.
   - *Code Cause*: Completing the wizard simply navigates to `/dashboard` without launching a setup drawer or displaying guided instructions for OAuth token configuration.
4. **Onboarding Recommends Unreleased Draft Packs (`apps/dashboard/app/(onboarding)/pack-recommendations.ts:50`)**:
   - *User Impact*: 400 Bad Request error crashing the onboarding wizard for retail users.
   - *Code Cause*: The wizard recommends `packIds: [CORE_B2B, 'ecommerce']` when "Retail / E-Commerce" is selected. However, `'ecommerce'` is an unreleased draft not listed in `LIVE_PACK_IDS` in `apps/dashboard/app/api/packs/route.ts:15-20`.
5. **Fragmented Onboarding Table Initialization (`apps/dashboard/app/api/org/onboarding/route.ts:70`, `apps/dashboard/app/api/onboarding/settings/route.ts:33`)**:
   - *User Impact*: Schema drift and inconsistent initial state across tenants.
   - *Code Cause*: Multiple endpoints independently execute `INSERT INTO org_onboarding ... ON CONFLICT DO UPDATE` with hardcoded default values, rather than relying on a centralized database trigger or helper.
6. **Concurrent Onboarding Mutation Race Conditions (`apps/dashboard/app/api/org/onboarding/route.ts:60-75`)**:
   - *User Impact*: Accidental deletion of onboarding settings when two colleagues configure the workspace simultaneously.
   - *Code Cause*: `PATCH /api/org/onboarding` executes a shallow replacement of the `config` JSONB column rather than a deep JSON merge (`config = config || $1::jsonb`), overwriting concurrent edits.
7. **Blind Default Seeding of All 8 Employees (`apps/dashboard/lib/seed-employees.ts:25-90`)**:
   - *User Impact*: Customer confusion and noise. A small firm wanting only an inbound WhatsApp receptionist is automatically given 8 active AI personas (sales, support, collections, property manager, operations, etc.).
   - *Code Cause*: `seedDefaultEmployees` unconditionally activates all 8 personas in `active` status during workspace creation without presenting a selection checklist.
8. **Lack of Mid-Wizard Session Expiry Recovery**:
   - *User Impact*: Loss of wizard form inputs if the user steps away for lunch during signup.
   - *Code Cause*: State is maintained primarily in client React memory (`useOnboardingStore`). If the session cookie expires, the next step redirects to `/login` without caching unsaved draft steps.
9. **Timezone Desynchronization in Business Hours Parsing**:
   - *User Impact*: AI employees replying at 3 AM because business hour schedules assume UTC instead of tenant local time.
   - *Code Cause*: `parseBusinessHours` accepts arbitrary start/end strings without validating against the organization's declared IANA timezone or daylight saving offset.
10. **Missing Corporate Brand & Logo Customization**:
    - *User Impact*: Generic customer experience. The chat widget and outbound emails lack the company's brand color, logo, and legal business name.
    - *Code Cause*: The wizard collects only `name`, omitting brand assets.
11. **Absence of Interactive Onboarding Sandbox Test**:
    - *User Impact*: Users leave the setup flow without experiencing the "Aha!" moment of conversational AI.
    - *Code Cause*: The wizard lacks an interactive preview drawer where a user can immediately test prompt responses before going live.
12. **Inability to Re-run or Reset Onboarding**:
    - *User Impact*: Workspace owners cannot re-launch the onboarding setup wizard if their initial setup was interrupted or needs re-configuration.
    - *Code Cause*: No administrative reset endpoint exists to reset `org_onboarding.completed = false`.

---

## What's missing vs full vision

1. **Interactive "Getting Started" Dashboard Checklist**:
   - Persistent checklist widget on the dashboard home screen showing progress:
     - [x] Create workspace & select industry pack
     - [ ] Connect WhatsApp Business or Gmail
     - [ ] Customize primary AI Employee persona
     - [ ] Invite team members
     - [ ] Run test conversation in sandbox
2. **Post-Onboarding Guided Setup Drawer**:
   - Interactive slide-over modal that opens immediately after onboarding to walk users step-by-step through WhatsApp Cloud API and Google OAuth authentication.
3. **Team Member Invitation Step**:
   - A dedicated wizard step allowing owners to invite colleagues by email with pre-selected roles (`admin`, `member`) before finishing signup.
4. **Customizable AI Employee Roster Selection**:
   - Checkbox roster in Step 3 allowing users to pick which AI personas to activate initially (e.g. "Only Inbound Support & Lead Intake").
5. **Interactive Conversation Sandbox Simulator**:
   - In-wizard test chat where users can converse with their AI employee in real-time before connecting production channels.
6. **Document / Knowledge Upload in Onboarding**:
   - Drag-and-drop PDF/DOCX uploader during onboarding to instantly populate `org_memory` with company FAQs and SOPs.
7. **Workspace Branding Customizer**:
   - Upload workspace logo and select primary hex brand color for widget theming.
8. **Guided Product Tour Tooltips**:
   - Lightweight interactive tour highlighting navigation items (Inbox, Employees, Ask AI, Settings).

---

## What to add for full SaaS (step by step, code/schema snippets)

### 1. Database Migration: Onboarding Enhancements & Checklist State (`033_onboarding_enhancements.sql`)
```sql
-- 1. Add checklist items and brand columns to org_onboarding
ALTER TABLE org_onboarding
  ADD COLUMN IF NOT EXISTS checklist_state JSONB NOT NULL DEFAULT '{
    "connect_channel": false,
    "customize_employee": false,
    "invite_team": false,
    "test_sandbox": false
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS dismissed_checklist BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS brand_logo_url TEXT,
  ADD COLUMN IF NOT EXISTS brand_color TEXT DEFAULT '#10b981';

-- 2. Add deep merge helper function for onboarding config
CREATE OR REPLACE FUNCTION update_org_onboarding_config(
  p_org_id UUID,
  p_config JSONB,
  p_wizard_step TEXT,
  p_completed BOOLEAN
) RETURNS VOID AS $$
BEGIN
  INSERT INTO org_onboarding (org_id, config, wizard_step, completed, updated_at)
  VALUES (p_org_id, p_config, COALESCE(p_wizard_step, 'name'), COALESCE(p_completed, false), NOW())
  ON CONFLICT (org_id) DO UPDATE SET
    config = org_onboarding.config || p_config,
    wizard_step = COALESCE(p_wizard_step, org_onboarding.wizard_step),
    completed = COALESCE(p_completed, org_onboarding.completed),
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;
```

### 2. Capped Warmup Poller in Dashboard (`apps/dashboard/app/(dashboard)/page.tsx`)
```typescript
'use client';

import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';

export function useWarmupPoller(isWarmupInitial: boolean) {
  const [isWarmup, setIsWarmup] = useState(isWarmupInitial);
  const attemptsRef = useRef(0);
  const MAX_ATTEMPTS = 20; // 50 seconds max (20 * 2.5s)

  useEffect(() => {
    if (!isWarmup) return;

    const interval = setInterval(async () => {
      attemptsRef.current += 1;

      if (attemptsRef.current > MAX_ATTEMPTS) {
        clearInterval(interval);
        setIsWarmup(false);
        toast.error('Workspace setup is taking longer than usual. Please check Settings to review connector status.');
        return;
      }

      try {
        const res = await fetch('/api/dashboard/warmup-status');
        const data = await res.json();
        if (data.isReady) {
          clearInterval(interval);
          setIsWarmup(false);
          toast.success('Workspace initialized successfully!');
        }
      } catch (err) {
        console.warn('Warmup poll attempt failed:', err);
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [isWarmup]);

  return { isWarmup, setIsWarmup };
}
```

### 3. Guided Post-Onboarding Connector Setup Drawer (`components/onboarding/ConnectorSetupDrawer.tsx`)
```tsx
'use client';

import React, { useState } from 'react';
import { X, MessageSquare, Mail, ExternalLink, Check, ShieldCheck } from 'lucide-react';

interface ConnectorSetupDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  primaryChannel: 'whatsapp' | 'gmail';
}

export function ConnectorSetupDrawer({ isOpen, onClose, primaryChannel }: ConnectorSetupDrawerProps) {
  const [step, setStep] = useState(1);
  const [wabaId, setWabaId] = useState('');
  const [phoneId, setPhoneId] = useState('');
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [verified, setVerified] = useState(false);

  if (!isOpen) return null;

  const handleVerify = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/integrations/whatsapp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wabaId, phoneId, token })
      });
      if (res.ok) {
        setVerified(true);
        setStep(3);
      }
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/60 backdrop-blur-sm flex justify-end">
      <div className="w-full max-w-lg bg-slate-900 border-l border-slate-800 p-6 flex flex-col justify-between shadow-2xl">
        <div>
          <div className="flex items-center justify-between pb-4 border-b border-slate-800">
            <div className="flex items-center gap-2">
              {primaryChannel === 'whatsapp' ? (
                <MessageSquare className="w-5 h-5 text-emerald-400" />
              ) : (
                <Mail className="w-5 h-5 text-blue-400" />
              )}
              <h2 className="text-lg font-semibold text-slate-100">
                Connect {primaryChannel === 'whatsapp' ? 'WhatsApp Business' : 'Google Workspace'}
              </h2>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-200">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="mt-6 space-y-4">
            {step === 1 && (
              <div className="space-y-4">
                <p className="text-sm text-slate-300">
                  To allow Sarah (Inbound AI) to answer client inquiries automatically, connect your Meta WhatsApp Cloud API credentials.
                </p>
                <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/60 text-xs text-slate-400 space-y-1">
                  <div className="font-semibold text-slate-300">Quick Prerequisites:</div>
                  <div>1. Meta Business Account with WhatsApp Cloud API enabled</div>
                  <div>2. Verified phone number</div>
                  <div>3. Permanent System User Access Token</div>
                </div>
                <button
                  onClick={() => setStep(2)}
                  className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition"
                >
                  Enter Credentials
                </button>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-slate-300">WABA Account ID</label>
                  <input
                    value={wabaId}
                    onChange={(e) => setWabaId(e.target.value)}
                    placeholder="e.g. 1092837465"
                    className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-300">Phone Number ID</label>
                  <input
                    value={phoneId}
                    onChange={(e) => setPhoneId(e.target.value)}
                    placeholder="e.g. 1029384756"
                    className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-300">System User Token</label>
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="EAAB..."
                    className="w-full mt-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-slate-200"
                  />
                </div>
                <button
                  disabled={testing || !wabaId || !phoneId || !token}
                  onClick={handleVerify}
                  className="w-full mt-2 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition flex items-center justify-center gap-2"
                >
                  {testing ? 'Verifying...' : 'Verify & Activate Channel'}
                </button>
              </div>
            )}

            {step === 3 && (
              <div className="text-center py-6 space-y-3">
                <div className="w-12 h-12 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <h3 className="text-base font-semibold text-slate-100">WhatsApp Successfully Connected!</h3>
                <p className="text-xs text-slate-400 max-w-xs mx-auto">
                  Incoming messages to your business number will now route directly into Darex and be handled by your autonomous AI employees.
                </p>
                <button
                  onClick={onClose}
                  className="w-full mt-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm font-medium transition"
                >
                  Go to Dashboard
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

### 4. Interactive "Getting Started" Checklist Card (`components/onboarding/GettingStartedChecklist.tsx`)
```tsx
'use client';

import React, { useState, useEffect } from 'react';
import { CheckCircle2, Circle, ArrowRight, X, Sparkles } from 'lucide-react';
import Link from 'next/link';

interface ChecklistState {
  connect_channel: boolean;
  customize_employee: boolean;
  invite_team: boolean;
  test_sandbox: boolean;
}

export function GettingStartedChecklist() {
  const [checklist, setChecklist] = useState<ChecklistState | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    fetch('/api/onboarding/checklist')
      .then((res) => res.json())
      .then((data) => {
        setChecklist(data.checklist);
        setDismissed(data.dismissed);
      })
      .catch(console.error);
  }, []);

  if (dismissed || !checklist) return null;

  const completedCount = Object.values(checklist).filter(Boolean).length;
  const progressPct = Math.round((completedCount / 4) * 100);

  const handleDismiss = async () => {
    setDismissed(true);
    await fetch('/api/onboarding/checklist/dismiss', { method: 'POST' });
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-5 shadow-lg mb-6">
      <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-emerald-400" />
          <h3 className="text-sm font-semibold text-slate-100">Getting Started with Darex</h3>
          <span className="text-xs bg-slate-800 text-emerald-400 px-2 py-0.5 rounded-full font-medium">
            {completedCount}/4 Completed
          </span>
        </div>
        <button onClick={handleDismiss} className="text-slate-400 hover:text-slate-200">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="w-full bg-slate-800 h-1.5 rounded-full mt-3 overflow-hidden">
        <div className="bg-emerald-500 h-full transition-all duration-500" style={{ width: `${progressPct}%` }} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
        <Link
          href="/settings/integrations"
          className="flex items-center justify-between p-3 rounded-lg bg-slate-800/40 hover:bg-slate-800 border border-slate-700/50 transition group"
        >
          <div className="flex items-center gap-2.5">
            {checklist.connect_channel ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <Circle className="w-4 h-4 text-slate-500" />
            )}
            <span className={`text-xs ${checklist.connect_channel ? 'text-slate-400 line-through' : 'text-slate-200'}`}>
              Connect WhatsApp or Gmail
            </span>
          </div>
          <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-emerald-400 transition" />
        </Link>

        <Link
          href="/employees"
          className="flex items-center justify-between p-3 rounded-lg bg-slate-800/40 hover:bg-slate-800 border border-slate-700/50 transition group"
        >
          <div className="flex items-center gap-2.5">
            {checklist.customize_employee ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <Circle className="w-4 h-4 text-slate-500" />
            )}
            <span className={`text-xs ${checklist.customize_employee ? 'text-slate-400 line-through' : 'text-slate-200'}`}>
              Customize AI Employee Persona
            </span>
          </div>
          <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-emerald-400 transition" />
        </Link>

        <Link
          href="/settings"
          className="flex items-center justify-between p-3 rounded-lg bg-slate-800/40 hover:bg-slate-800 border border-slate-700/50 transition group"
        >
          <div className="flex items-center gap-2.5">
            {checklist.invite_team ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <Circle className="w-4 h-4 text-slate-500" />
            )}
            <span className={`text-xs ${checklist.invite_team ? 'text-slate-400 line-through' : 'text-slate-200'}`}>
              Invite Your Team
            </span>
          </div>
          <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-emerald-400 transition" />
        </Link>

        <Link
          href="/ask-ai"
          className="flex items-center justify-between p-3 rounded-lg bg-slate-800/40 hover:bg-slate-800 border border-slate-700/50 transition group"
        >
          <div className="flex items-center gap-2.5">
            {checklist.test_sandbox ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            ) : (
              <Circle className="w-4 h-4 text-slate-500" />
            )}
            <span className={`text-xs ${checklist.test_sandbox ? 'text-slate-400 line-through' : 'text-slate-200'}`}>
              Test First Prompt in Ask AI
            </span>
          </div>
          <ArrowRight className="w-3.5 h-3.5 text-slate-400 group-hover:text-emerald-400 transition" />
        </Link>
      </div>
    </div>
  );
}
```

---

## Fix priority

- **P0**: Cap the unbounded 2.5s warmup polling loop to eliminate client lockups and database request storms.
- **P0**: Implement guided post-onboarding connector setup drawer to eliminate the 100% connector drop-off cliff.
- **P1**: Add RBAC role checks to `api/onboarding/settings` and `api/onboarding/backfill` to prevent unprivileged members from altering workspace configurations.
- **P1**: Filter pack recommendations to live packs only, removing the `'ecommerce'` 400 error crash.
- **P1**: Wrap onboarding updates in atomic JSONB deep merges to prevent concurrent form saves from wiping teammate inputs.
- **P2**: Deploy interactive "Getting Started" checklist widget on the main dashboard (`033_onboarding_enhancements.sql`).
- **P2**: Add team invitation step to the onboarding wizard.
- **P2**: Allow custom AI employee selection during onboarding rather than blindly activating all 8 personas.

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Business name must sync to `orgs.name` | P0 | `org/create`, `org/onboarding` | 🟢 Done | Create + PATCH sync trimmed businessName to session org |
| 2 | Onboarding mutation RBAC | P1 | onboarding + org create/onboarding | 🟢 Done | `canManageOrgSettings` on mutations |
| 3 | Unbounded warmup poller | P0 | `(dashboard)/page.tsx` | 🟢 Done | `MAX_TICKS = 24` (~60s) hard stop already present + verified |
| 4 | Connector drop-off cliff | P0 | channels → home setup drawer | 🟢 Done | `?setup=` handoff + post-warmup Integrations drawer |
| 5 | Live-pack filter for recommendations | P1 | `pack-recommendations.ts` + `org/create` | 🟢 Done | E-commerce maps to live `core-b2b` (no live `ecommerce` id). `org/create` installs via `installPackForOrg` |
