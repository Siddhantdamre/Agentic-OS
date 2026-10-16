# Skills Audit

## Live Resolution Tracker

| # | Issue / Gap Description | Severity | Target File:Line | Status | Verification & Fix Details |
|---|-------------------------|----------|------------------|--------|----------------------------|
| 1 | Dynamic skill tool loading with per-org capability gating (runtime) | P0 | `skills/catalog.ts`, `tool-executor.ts` | 🟢 Done | Ready skills expand tools only when providers are connected. |
| 2 | In-process tool schemas invent connectors without ownership | P0 | `local-tool-select.ts` | 🟢 Done | Allowlist intersection only. |
| 3 | Dashboard `/api/skills` + org_skills schema + UI toggles | P0 | `apps/dashboard/**` + `099_org_skills.sql` | 🟢 Done | GET/PATCH skills API, org_skills/employee_skills migration, live SkillsView toggles. |
| 4 | Sync skill assignments ↔ `ai_employees.tool_allowlist` via API | P0 | `apps/dashboard/app/api/skills/[id]/route.ts` | 🟢 Done | PATCH rebuilds employee allowlists from assigned enabled skills. |
| 5 | Enforce `minAutonomyLevel` at tool execution | P1 | `skills/catalog.ts` + `tool-executor.ts` + `tool-gate.ts` | 🟢 Done | `minAutonomyForTool` + employee_autonomy_rules tier check before execute. 2026-10-05: below the minimum a call now parks for human approval (`skill_tier`) instead of being refused; reads, drafts and approved re-entries skip the check. |
| 6 | Live Nango connector status on skills UI | P1 | dashboard skills page | 🟢 Done | Provider status from org_connectors + channels; honest not connected. |

## Status: closed (runtime gating + dashboard `/api/skills` + allowlist sync + live connector status)

The Skills domain (`apps/dashboard/app/(dashboard)/skills/page.tsx`) loads live readiness from `/api/skills`, with org toggles, employee assignment, allowlist sync, and honest connector status.

**2026-09-26 update:** Workflows runtime loads first-party skill tools dynamically, gates on connected channels, and enforces `minAutonomyLevel`. Dashboard API/schema/UI + Nango status shipped.

---

## What works (cite file:line)

1. **Clean Route & App Navigation Integration**:
   - `apps/dashboard/app/(dashboard)/skills/page.tsx:6-16` — The page loads cleanly without 404s, renders with the standard dashboard layout shell, and is linked from `apps/dashboard/components/layout/AppShell.tsx:47`.
2. **References Real Tool Namespaces**:
   - `page.tsx:18-97` — Tool names listed inside `requiresTools`:
     - `mcp.darex.whatsapp_send` matches WhatsApp messaging in `services/workflows/src/tool-executor.ts:375-390`.
     - `mcp.darex.gmail_fetch` and `mcp.darex.gmail_send` match Gmail connector actions in `services/workflows/src/tools/google.ts`.
     - `mcp.darex.hubspot_create_contact` and `mcp.darex.hubspot_create_deal` match HubSpot CRM tools in `services/workflows/src/tools/crm.ts`.
     - `mcp.darex.stripe_create_payment_link` matches payment actions in `services/workflows/src/tools/stripe.ts`.
     - `mcp.darex.calendar_list_events` and `calendar_create_event` match Google Calendar scheduling in `services/workflows/src/tools/calendar.ts`.
3. **SSE MCP Bridge Tool Schema Mapping**:
   - `services/workflows/src/mcp-bridge.ts:88-120` — The tool names referenced in `requiresTools` are registered in the SSE MCP server running on port 8790, allowing TrueForge agents to query tool definitions via the Model Context Protocol.
4. **Honest Scope Framing on Marketplace**:
   - `page.tsx:104-120` — Avoids fake marketplace claims: explicitly declares that unreviewed community/third-party skill packs cannot execute arbitrary code in tenant workspaces, pointing developers to `docs/current-working/marketplace-preview.md`.
5. **Rich TypeScript Metadata Definitions**:
   - `page.tsx:18-97` — Defines well-structured TypeScript interfaces (`SkillDefinition`) containing `id`, `name`, `description`, `category`, `version`, `author`, `requiresTools`, `minAutonomyLevel`, and `recommendedRole`, giving a clear blueprint for the relational schema needed.
6. **Responsive Card Layout**:
   - `page.tsx:125-180` — Uses Tailwind CSS grid (`grid-cols-1 md:grid-cols-2 lg:grid-cols-3`) with category color-coding (Communication: blue, CRM: amber, Operations: emerald, Finance: purple).

---

## What's broken (code-level bugs, edge cases, failure modes)

1. **Total Absence of a Backing API Route (P0)**:
   - There is no `/api/skills` directory or route in `apps/dashboard/app/api/`.
   - While routes like `/api/conversations`, `/api/connectors`, `/api/employees`, and `/api/analytics` properly use `getScopedClient()` from `lib/db.ts` to enforce tenant RLS, `/skills` is an inert React component with **zero data-fetching logic**. A network trace confirms zero XHR/fetch requests are emitted on page visit.
2. **Static In-File Array with Stale Static Versions (`page.tsx:18-97`)**:
   - All 11 skills are hardcoded directly into the TSX file.
   - There is no database table (`skills` or `org_skills`), no YAML registry, and no system catalog in Postgres.
   - The `version: '1.0.0'` tags are static strings that never increment, cannot be updated via patches, and have no checksums or semantic versioning verification.
3. **Completely Decoupled from `ai_employees.tool_allowlist` (P0)**:
   - In the Darex TrueForge agent runtime (`services/workflows/src/local-turn.ts:80-115` and `apps/dashboard/app/api/employees/route.ts:45-80`), an AI employee's runtime execution capability is strictly determined by its `tool_allowlist` column in `ai_employees`.
   - The Skills UI has **zero awareness** of `ai_employees.tool_allowlist`. An admin viewing `/skills` has no way to see which employees possess the skill, cannot assign a skill to an employee, and cannot revoke a skill when an employee goes rogue.
4. **Completely Blind to Nango OAuth Connector Status**:
   - Most skills require specific third-party connectors (e.g., WhatsApp, HubSpot, Gmail, Shopify, Stripe).
   - The UI displays identical static cards regardless of whether the tenant has actually connected those integrations in `/connectors`. A tenant with zero connected integrations sees "Lead Qualification & CRM Sync" as if it is ready to use, leading to immediate runtime failures (`status: 'error'`, `connected: false`) if invoked by an agent.
5. **Zero Interactivity & Dead Cards**:
   - Cards render as pure HTML `<div>` elements without `onClick` handlers, buttons, sliders, or expandable drawers.
   - There is no toggle to disable a skill org-wide, no way to configure skill parameters (e.g., custom prompt templates, retry thresholds, or fallback behavior), and no link to `/connectors` to resolve missing dependencies.
6. **No Runtime Enforcement of `minAutonomyLevel`**:
   - `page.tsx` defines `minAutonomyLevel: 2` or `3` for dangerous skills (e.g., `refund_processing`, `contract_drafting`).
   - However, in `services/workflows/src/tool-executor.ts` and `apps/dashboard/lib/autonomy.ts`, there is zero validation checking whether the invoking employee's autonomy level meets the skill's declared minimum requirement. An employee configured with `autonomy_level = 1` can still trigger tools if they are in its `tool_allowlist`.
7. **No Fallback / Graceful Error if Skill Tools Fail at Runtime**:
   - When an agent calls a skill composed of multi-step tools (e.g., fetch email -> extract lead -> create HubSpot contact), if intermediate tool step 2 fails, there is no transactional rollback or skill-level error handler; the workflow halts mid-turn without recording a skill failure in the audit log.
8. **Missing Tool Dependency Validation on Employee Creation**:
   - When an admin manually adds tools to an employee in `apps/dashboard/app/api/employees/route.ts`, the API does not verify if the employee possesses all required companion tools for a skill (e.g. assigning `hubspot_create_deal` without `hubspot_create_contact`).
9. **No Tenant Customization Overlays**:
   - Different organizations have different business rules for the same skill (e.g., Brokerage A requires 20% down payment verification during qualification; Brokerage B requires 10%). Currently, prompts are hardcoded in worker prompts with no tenant overlay storage.
10. **Silent Privilege Escalation Risk**:
    - An employee with read-only permissions can be assigned an action-oriented skill in the UI if there is no backend role validation between the employee persona and the skill's risk profile.
11. **No Concurrency Guard on Skill Toggles**:
    - If two workspace managers attempt to toggle skill settings simultaneously, the lack of version checking on employee allowlists risks lost updates.
12. **Missing Invalidation of Agent Execution Sessions**:
    - If a skill is revoked or disabled, active TrueForge sessions in `services/workflows/src/local-turn.ts` continue to hold cached tool definitions in memory until process restart.

---

## What's missing vs full product vision

1. **Live Tenant-Scoped Skill Readiness Engine**:
   - A real SaaS skills manager must compute live readiness for each skill:
     - `Ready`: All required connectors are authorized, valid tokens present, and at least one active employee is assigned.
     - `Missing Connection`: Required OAuth connector (e.g., HubSpot) is disconnected or expired; provides a 1-click "Connect" button launching the Nango modal.
     - `Unassigned`: Connectors exist, but no AI employee currently has this skill in their allowlist.
     - `Disabled`: Explicitly turned off by the organization admin.
2. **Employee Assignment Matrix**:
   - Visual drag-and-drop or multi-select dropdown allowing workspace owners to grant skills to specific employees (e.g., assign "Inbox Triager" to Emma, "Pipeline Accelerator" to David).
   - Automatic bi-directional synchronization between the assigned skills and the employee's `ai_employees.tool_allowlist` in Postgres.
3. **Live Execution & Value Metrics**:
   - Integration with `agent_decision_ledger`:
     - Number of invocations over the last 7d/30d.
     - Success rate (% completed without error or human rejection).
     - Average latency per execution.
     - Estimated hours saved (derived from skill complexity and execution volume).
4. **Custom Skill Builder & Parameterization**:
   - Ability for enterprise admins to define custom skills combining existing MCP tools with tenant-specific prompt instructions and guardrails.
   - Parameter schemas allowing admins to define inputs (e.g., maximum auto-refund limit = $100).
5. **External MCP Server Skills Mount**:
   - Organization-level capability to connect third-party Model Context Protocol (MCP) servers (e.g., internal enterprise databases, legacy ERPs) and automatically ingest their tool definitions as custom skills.
6. **Skill Execution History Drawer**:
   - Clicking a skill card should open an execution ledger showing the last 50 times that skill was used, by which employee, for which customer conversation, and the full input/output payload.
7. **Skill Versioning & Rollback**:
   - Support for skill version increments (`1.0.0` -> `1.1.0`), allowing admins to review diffs and rollback if a prompt update degrades performance.
8. **Skill-Level Cost Tracking**:
   - Telemetry showing total LLM token consumption and API cost incurred specifically by invoking this skill.

---

## What to add for full SaaS

### 1. Database Migration: `023_skills_and_allowlists.sql`
```sql
-- Global system skills catalog
CREATE TABLE system_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('communication', 'crm', 'operations', 'finance', 'real_estate', 'legal')),
  version TEXT NOT NULL DEFAULT '1.0.0',
  requires_tools TEXT[] NOT NULL DEFAULT '{}',
  min_autonomy_level INT NOT NULL DEFAULT 1 CHECK (min_autonomy_level BETWEEN 1 AND 4),
  recommended_role TEXT,
  default_prompt_overlay TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant-specific skill configuration and overrides
CREATE TABLE org_skills (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES system_skills(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  custom_prompt_overlay TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, skill_id)
);

-- Junction table mapping skills directly to AI employees
CREATE TABLE employee_skills (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES ai_employees(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES system_skills(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, employee_id, skill_id)
);

CREATE INDEX idx_org_skills_lookup ON org_skills(org_id, enabled);
CREATE INDEX idx_employee_skills_lookup ON employee_skills(org_id, employee_id);

ALTER TABLE system_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_skills ENABLE ROW LEVEL SECURITY;

CREATE POLICY system_skills_read ON system_skills FOR SELECT USING (true);
CREATE POLICY org_skills_tenant ON org_skills FOR ALL 
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY employee_skills_tenant ON employee_skills FOR ALL 
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
```

### 2. Backend API Implementation: `apps/dashboard/app/api/skills/route.ts`
Create `apps/dashboard/app/api/skills/route.ts`:
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole } from '@/lib/rbac';

export async function GET(request: Request) {
  const { client, orgId } = await getScopedClient();
  try {
    // 1. Fetch system skills joined with org overrides
    const skillsRes = await client.query(`
      SELECT s.id, s.name, s.description, s.category, s.version, s.requires_tools,
             s.min_autonomy_level, s.recommended_role,
             COALESCE(os.enabled, true) as enabled,
             os.custom_prompt_overlay, os.config
        FROM system_skills s
        LEFT JOIN org_skills os ON os.skill_id = s.id AND os.org_id = $1
       ORDER BY s.category, s.name
    `, [orgId]);

    // 2. Fetch active connected connectors for tenant
    const connRes = await client.query(
      `SELECT provider, status FROM org_connectors WHERE org_id = $1 AND status = 'connected'`,
      [orgId]
    );
    const connectedProviders = new Set(connRes.rows.map(r => r.provider));

    // 3. Fetch employee assignments
    const empSkillsRes = await client.query(`
      SELECT es.skill_id, e.id as employee_id, e.name as employee_name, e.role as employee_role
        FROM employee_skills es
        JOIN ai_employees e ON e.id = es.employee_id
       WHERE es.org_id = $1 AND e.status = 'active'
    `, [orgId]);

    // Group employees by skill
    const assignments: Record<string, Array<{ id: string; name: string; role: string }>> = {};
    for (const row of empSkillsRes.rows) {
      if (!assignments[row.skill_id]) assignments[row.skill_id] = [];
      assignments[row.skill_id].push({
        id: row.employee_id,
        name: row.employee_name,
        role: row.employee_role
      });
    }

    // 4. Assemble computed readiness status
    const skills = skillsRes.rows.map(skill => {
      const missingTools = skill.requires_tools.filter((t: string) => {
        const provider = t.replace('mcp.darex.', '').split('_')[0];
        return !connectedProviders.has(provider);
      });

      let status = 'ready';
      if (!skill.enabled) status = 'disabled';
      else if (missingTools.length > 0) status = 'missing_tools';
      else if (!assignments[skill.id] || assignments[skill.id].length === 0) status = 'unassigned';

      return {
        ...skill,
        computedStatus: status,
        missingTools,
        assignedEmployees: assignments[skill.id] || []
      };
    });

    return NextResponse.json({ skills });
  } finally {
    client.release();
  }
}
```

### 3. Skill Mutation and Tool Allowlist Synchronization: `apps/dashboard/app/api/skills/[id]/route.ts`
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { loadHumanRole } from '@/lib/rbac';

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const { client, orgId, userId } = await getScopedClient();
  try {
    const role = await loadHumanRole(client, orgId, userId);
    if (role !== 'owner' && role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: Admin access required.' }, { status: 403 });
    }

    const body = await request.json();
    const { enabled, assignedEmployeeIds, customPromptOverlay, config } = body;

    await client.query('BEGIN');

    // Update org_skills config
    await client.query(`
      INSERT INTO org_skills (org_id, skill_id, enabled, custom_prompt_overlay, config, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (org_id, skill_id) DO UPDATE SET
        enabled = COALESCE($3, org_skills.enabled),
        custom_prompt_overlay = COALESCE($4, org_skills.custom_prompt_overlay),
        config = COALESCE($5, org_skills.config),
        updated_at = NOW()
    `, [orgId, params.id, enabled, customPromptOverlay, JSON.stringify(config || {})]);

    // Update employee assignments if provided
    if (Array.isArray(assignedEmployeeIds)) {
      await client.query(`DELETE FROM employee_skills WHERE org_id = $1 AND skill_id = $2`, [orgId, params.id]);
      for (const empId of assignedEmployeeIds) {
        await client.query(
          `INSERT INTO employee_skills (org_id, employee_id, skill_id) VALUES ($1, $2, $3)`,
          [orgId, empId, params.id]
        );
      }

      // Synchronize ai_employees.tool_allowlist in Postgres
      const skillRes = await client.query(`SELECT requires_tools FROM system_skills WHERE id = $1`, [params.id]);
      const toolsToAdd = skillRes.rows[0]?.requires_tools || [];

      if (enabled) {
        await client.query(`
          UPDATE ai_employees
             SET tool_allowlist = array_cat(tool_allowlist, $1::text[])
           WHERE org_id = $2 AND id = ANY($3::uuid[])
        `, [toolsToAdd, orgId, assignedEmployeeIds]);
      }
    }

    await client.query('COMMIT');
    return NextResponse.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

### 4. Interactive UI Component (`apps/dashboard/app/(dashboard)/skills/SkillsView.tsx`)
```tsx
'use client';

import { useState } from 'react';
import { Wand2, CheckCircle2, AlertCircle, ShieldAlert, Link as LinkIcon } from 'lucide-react';
import Link from 'next/link';

export function SkillsView({ initialSkills }: { initialSkills: any[] }) {
  const [skills, setSkills] = useState(initialSkills);
  const [filter, setFilter] = useState('all');

  const handleToggle = async (skillId: string, currentEnabled: boolean) => {
    try {
      const res = await fetch(`/api/skills/${skillId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !currentEnabled }),
      });
      if (!res.ok) throw new Error('Failed to update skill state');
      setSkills(skills.map(s => s.id === skillId ? { ...s, enabled: !currentEnabled } : s));
    } catch (err: any) {
      alert(err.message);
    }
  };

  const filtered = filter === 'all' ? skills : skills.filter(s => s.category.toLowerCase() === filter);

  return (
    <div className="space-y-6">
      <div className="flex space-x-2 border-b pb-3">
        {['all', 'communication', 'crm', 'operations', 'finance'].map(cat => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize ${
              filter === cat ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filtered.map(skill => (
          <div key={skill.id} className="bg-white dark:bg-gray-900 border rounded-xl p-5 shadow-sm flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-start mb-3">
                <span className="px-2.5 py-1 text-xs font-semibold rounded bg-blue-50 text-blue-700 dark:bg-blue-950/40">
                  {skill.category}
                </span>
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  onChange={() => handleToggle(skill.id, skill.enabled)}
                  className="h-4 w-4 rounded text-blue-600 cursor-pointer"
                />
              </div>

              <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-base mb-1">{skill.name}</h3>
              <p className="text-xs text-gray-500 mb-4">{skill.description}</p>
            </div>

            <div className="pt-4 border-t space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400">Status</span>
                {skill.computedStatus === 'ready' && (
                  <span className="text-emerald-600 font-medium flex items-center">
                    <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Ready
                  </span>
                )}
                {skill.computedStatus === 'missing_tools' && (
                  <Link href="/connectors" className="text-amber-600 font-medium flex items-center hover:underline">
                    <AlertCircle className="w-3.5 h-3.5 mr-1" /> Connect OAuth
                  </Link>
                )}
                {skill.computedStatus === 'unassigned' && (
                  <span className="text-blue-600 font-medium">Unassigned</span>
                )}
              </div>

              <div className="flex flex-wrap gap-1">
                {skill.requires_tools?.slice(0, 3).map((t: string) => (
                  <span key={t} className="text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-600 px-1.5 py-0.5 rounded font-mono">
                    {t.replace('mcp.darex.', '')}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 5. Runtime Autonomy Guardrail (`services/workflows/src/tool-executor.ts`)
```typescript
export async function assertSkillAutonomyGuard(
  client: any,
  orgId: string,
  employeeId: string,
  toolName: string
): Promise<void> {
  const query = `
    SELECT s.min_autonomy_level, e.name as employee_name, ear.autonomy_tier
      FROM system_skills s
      JOIN employee_skills es ON es.skill_id = s.id
      JOIN ai_employees e ON e.id = es.employee_id
 LEFT JOIN employee_autonomy_rules ear ON ear.org_id = $1 AND ear.employee_role = e.role
     WHERE es.org_id = $1 AND es.employee_id = $2 AND $3 = ANY(s.requires_tools)
     LIMIT 1
  `;
  const res = await client.query(query, [orgId, employeeId, toolName]);
  if (res.rowCount > 0) {
    const { min_autonomy_level, employee_name, autonomy_tier } = res.rows[0];
    const tierLevelMap: Record<string, number> = {
      notice: 1,
      draft: 2,
      act_internally: 3,
      act_externally: 4,
    };
    const currentLevel = tierLevelMap[autonomy_tier] || 1;
    if (currentLevel < min_autonomy_level) {
      throw new Error(
        `Action blocked: Employee ${employee_name} autonomy tier (${autonomy_tier}) does not meet the minimum required autonomy level (${min_autonomy_level}) for this skill.`
      );
    }
  }
}
```

### 6. Skill Invocation History Endpoint (`apps/dashboard/app/api/skills/[id]/history/route.ts`)
```typescript
import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const { client, orgId } = await getScopedClient();
  try {
    const res = await client.query(
      `SELECT dl.id, dl.action_type, dl.status, dl.created_at, e.name as employee_name
         FROM agent_decision_ledger dl
         JOIN ai_employees e ON e.id = dl.employee_id
        WHERE dl.org_id = $1 AND dl.skill_id = $2
        ORDER BY dl.created_at DESC
        LIMIT 50`,
      [orgId, params.id]
    );

    return NextResponse.json({ history: res.rows });
  } finally {
    client.release();
  }
}
```

---

## Fix priority

- **P0**: Build `GET /api/skills` and `PATCH /api/skills/[id]` to eliminate the inert client stub and synchronize skill assignments with `ai_employees.tool_allowlist`.
- **P1**: Integrate live Nango connector status into the skills view and provide direct deep-links to OAuth setup.
- **P1**: Enforce `minAutonomyLevel` checks at runtime in `tool-executor.ts` to prevent low-autonomy employees from executing sensitive tools.
- **P1**: Invalidate active agent execution sessions upon skill revocation to stop unauthorized tool execution.
- **P2**: Surface 30-day invocation volume and success metrics from `agent_decision_ledger` on each skill card.
- **P2**: Implement custom MCP server mounting and external skill ingestion.
- **P2**: Add skill execution history drawer showing inputs, outputs, and linked conversation context.
