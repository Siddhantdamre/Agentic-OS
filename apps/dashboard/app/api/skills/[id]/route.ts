import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { tryReadJson } from '@/lib/safe-json';
import { canManageOrgSettings, loadHumanRole } from '@/lib/rbac';
import { FIRST_PARTY_SKILLS } from '@darex/workflows/dist/skills/catalog';

export const dynamic = 'force-dynamic';

function normalizeTool(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/^mcp\.darex\./, '')
    .replace(/_/g, '-');
}

function parseAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === 'string' && t.length > 0);
}

function skillById(id: string) {
  return FIRST_PARTY_SKILLS.find((s) => s.id === id) || null;
}

/** Rebuild allowlist for one employee from all assigned skills + tools not owned by any skill. */
async function syncEmployeeAllowlist(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  orgId: string,
  employeeId: string,
): Promise<void> {
  const empRes = await client.query(
    `SELECT tool_allowlist FROM ai_employees WHERE org_id = $1 AND id = $2`,
    [orgId, employeeId],
  );
  if (!empRes.rows[0]) return;

  const current = parseAllowlist(empRes.rows[0].tool_allowlist);
  const allSkillTools = new Set<string>();
  for (const skill of FIRST_PARTY_SKILLS) {
    for (const t of skill.requiresTools) allSkillTools.add(normalizeTool(t));
  }

  const assignedRes = await client.query(
    `SELECT skill_id FROM employee_skills WHERE org_id = $1 AND employee_id = $2`,
    [orgId, employeeId],
  );
  const enabledRes = await client.query(
    `SELECT skill_id, enabled FROM org_skills WHERE org_id = $1`,
    [orgId],
  );
  const enabledMap = new Map(
    (enabledRes.rows as Array<{ skill_id: string; enabled: boolean }>).map((r) => [r.skill_id, r.enabled]),
  );

  const fromSkills = new Set<string>();
  for (const row of assignedRes.rows as Array<{ skill_id: string }>) {
    if (enabledMap.get(row.skill_id) === false) continue;
    const skill = skillById(row.skill_id);
    if (!skill) continue;
    for (const t of skill.requiresTools) fromSkills.add(normalizeTool(t));
  }

  // Keep non-skill tools the employee already had; replace skill-owned tools with current assignments.
  const preserved = current.filter((t) => !allSkillTools.has(normalizeTool(t)));
  const next = Array.from(new Set([...preserved, ...fromSkills]));

  await client.query(
    `UPDATE ai_employees SET tool_allowlist = $1::text[], updated_at = NOW()
      WHERE org_id = $2 AND id = $3`,
    [next, orgId, employeeId],
  );
}

export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const skillId = String(params.id || '').trim();
    const skill = skillById(skillId);
    if (!skill) {
      return NextResponse.json({ error: 'Unknown skill' }, { status: 404 });
    }

    const body = await tryReadJson<{
      enabled?: unknown;
      assignedEmployeeIds?: unknown;
      customPromptOverlay?: unknown;
      config?: unknown;
      org_id?: unknown;
      orgId?: unknown;
    }>(request);
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (body.org_id !== undefined || body.orgId !== undefined) {
      return NextResponse.json({ error: 'org_id is not accepted in the body' }, { status: 400 });
    }

    const { client, orgId, userId } = await getScopedClient();
    try {
      const humanRole = await loadHumanRole(client, userId);
      if (!canManageOrgSettings(humanRole)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
      const customPromptOverlay =
        body.customPromptOverlay === null
          ? null
          : typeof body.customPromptOverlay === 'string'
            ? body.customPromptOverlay
            : undefined;
      const config =
        body.config && typeof body.config === 'object' && !Array.isArray(body.config)
          ? body.config
          : undefined;
      const assignedEmployeeIds = Array.isArray(body.assignedEmployeeIds)
        ? body.assignedEmployeeIds.filter((id): id is string => typeof id === 'string' && !!id)
        : undefined;

      await client.query('BEGIN');

      if (enabled !== undefined || customPromptOverlay !== undefined || config !== undefined) {
        await client.query(
          `INSERT INTO org_skills (org_id, skill_id, enabled, custom_prompt_overlay, config, updated_at)
           VALUES ($1, $2, COALESCE($3, true), $4, COALESCE($5::jsonb, '{}'::jsonb), NOW())
           ON CONFLICT (org_id, skill_id) DO UPDATE SET
             enabled = COALESCE($3, org_skills.enabled),
             custom_prompt_overlay = COALESCE($4, org_skills.custom_prompt_overlay),
             config = COALESCE($5::jsonb, org_skills.config),
             updated_at = NOW()`,
          [
            orgId,
            skillId,
            enabled ?? null,
            customPromptOverlay === undefined ? null : customPromptOverlay,
            config === undefined ? null : JSON.stringify(config),
          ],
        );
      }

      const touchedEmployees = new Set<string>();

      if (assignedEmployeeIds !== undefined) {
        const prior = await client.query(
          `SELECT employee_id FROM employee_skills WHERE org_id = $1 AND skill_id = $2`,
          [orgId, skillId],
        );
        for (const row of prior.rows as Array<{ employee_id: string }>) {
          touchedEmployees.add(row.employee_id);
        }

        if (assignedEmployeeIds.length > 0) {
          const valid = await client.query(
            `SELECT id FROM ai_employees WHERE org_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'`,
            [orgId, assignedEmployeeIds],
          );
          const validIds = (valid.rows as Array<{ id: string }>).map((r) => r.id);
          if (validIds.length !== assignedEmployeeIds.length) {
            await client.query('ROLLBACK');
            return NextResponse.json({ error: 'One or more employees are invalid' }, { status: 400 });
          }
        }

        await client.query(`DELETE FROM employee_skills WHERE org_id = $1 AND skill_id = $2`, [
          orgId,
          skillId,
        ]);
        for (const empId of assignedEmployeeIds) {
          await client.query(
            `INSERT INTO employee_skills (org_id, employee_id, skill_id) VALUES ($1, $2, $3)`,
            [orgId, empId, skillId],
          );
          touchedEmployees.add(empId);
        }
      }

      // When enabling/disabling, resync all employees currently assigned this skill.
      if (enabled !== undefined && assignedEmployeeIds === undefined) {
        const assigned = await client.query(
          `SELECT employee_id FROM employee_skills WHERE org_id = $1 AND skill_id = $2`,
          [orgId, skillId],
        );
        for (const row of assigned.rows as Array<{ employee_id: string }>) {
          touchedEmployees.add(row.employee_id);
        }
      }

      for (const empId of touchedEmployees) {
        await syncEmployeeAllowlist(client, orgId, empId);
      }

      await client.query('COMMIT');
      return NextResponse.json({ success: true, skillId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const __scopedAuth = scopedAuthErrorResponse(error instanceof Error ? error : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/skills/[id] PATCH Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
