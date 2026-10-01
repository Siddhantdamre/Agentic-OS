import { NextResponse } from 'next/server';
import { getScopedClient, scopedAuthErrorResponse } from '@/lib/db';
import { FIRST_PARTY_SKILLS } from '@darex/workflows/dist/skills/catalog';

export const dynamic = 'force-dynamic';

function normalizeProvider(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/^mcp\.darex\./, '')
    .replace(/_/g, '-');
}

type ConnectorRow = {
  connector_key: string;
  status: string;
  nango_connection_id: string | null;
};

type ChannelRow = { channel_type: string };

function connectedProviderSet(
  connectors: ConnectorRow[],
  channels: ChannelRow[],
): Map<string, { connected: boolean; source: 'nango' | 'channel' | 'none'; status: string }> {
  const map = new Map<string, { connected: boolean; source: 'nango' | 'channel' | 'none'; status: string }>();

  for (const row of channels) {
    const key = normalizeProvider(row.channel_type);
    if (!key) continue;
    map.set(key, { connected: true, source: 'channel', status: 'connected' });
  }

  for (const row of connectors) {
    const key = normalizeProvider(row.connector_key);
    if (!key) continue;
    const isConnected = row.status === 'connected' && !!row.nango_connection_id;
    const prev = map.get(key);
    if (isConnected) {
      map.set(key, { connected: true, source: 'nango', status: row.status });
    } else if (!prev?.connected) {
      map.set(key, {
        connected: false,
        source: row.nango_connection_id ? 'nango' : 'none',
        status: row.status || 'disconnected',
      });
    }
  }

  return map;
}

export async function GET() {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const [orgSkillsRes, empSkillsRes, connectorsRes, channelsRes, employeesRes] = await Promise.all([
        client.query(
          `SELECT skill_id, enabled, custom_prompt_overlay, config, updated_at
             FROM org_skills WHERE org_id = $1`,
          [orgId],
        ),
        client.query(
          `SELECT es.skill_id, e.id AS employee_id, e.name AS employee_name, e.role AS employee_role
             FROM employee_skills es
             JOIN ai_employees e ON e.id = es.employee_id AND e.org_id = es.org_id
            WHERE es.org_id = $1 AND e.status = 'active'`,
          [orgId],
        ),
        client.query(
          `SELECT connector_key, status, nango_connection_id
             FROM org_connectors WHERE org_id = $1`,
          [orgId],
        ),
        client.query(
          `SELECT channel_type FROM channels
            WHERE org_id = $1 AND status IN ('active', 'connected')`,
          [orgId],
        ),
        client.query(
          `SELECT id, name, role FROM ai_employees
            WHERE org_id = $1 AND status = 'active'
            ORDER BY created_at ASC`,
          [orgId],
        ),
      ]);

      const orgBySkill = new Map(
        orgSkillsRes.rows.map((r: { skill_id: string; enabled: boolean; custom_prompt_overlay: string | null; config: unknown }) => [
          r.skill_id,
          r,
        ]),
      );

      const assignments: Record<string, Array<{ id: string; name: string; role: string }>> = {};
      for (const row of empSkillsRes.rows as Array<{
        skill_id: string;
        employee_id: string;
        employee_name: string;
        employee_role: string;
      }>) {
        if (!assignments[row.skill_id]) assignments[row.skill_id] = [];
        assignments[row.skill_id].push({
          id: row.employee_id,
          name: row.employee_name,
          role: row.employee_role,
        });
      }

      const connected = connectedProviderSet(
        connectorsRes.rows as ConnectorRow[],
        channelsRes.rows as ChannelRow[],
      );

      const skills = FIRST_PARTY_SKILLS.map((skill) => {
        const org = orgBySkill.get(skill.id) as
          | { enabled: boolean; custom_prompt_overlay: string | null; config: unknown }
          | undefined;
        const enabled = org?.enabled ?? true;

        const providerStatuses = skill.requiresProviders.map((p) => {
          const key = normalizeProvider(p);
          const info = connected.get(key);
          if (info?.connected) {
            return { provider: p, connected: true as const, status: info.status, source: info.source };
          }
          return {
            provider: p,
            connected: false as const,
            status: info?.status || 'not_connected',
            source: info?.source || 'none',
          };
        });

        const missingProviders = providerStatuses.filter((p) => !p.connected).map((p) => p.provider);
        const anyConnected = providerStatuses.some((p) => p.connected);
        const assigned = assignments[skill.id] || [];

        let computedStatus: 'ready' | 'disabled' | 'not_connected' | 'unassigned' = 'ready';
        if (!enabled) computedStatus = 'disabled';
        else if (!anyConnected) computedStatus = 'not_connected';
        else if (assigned.length === 0) computedStatus = 'unassigned';

        return {
          id: skill.id,
          name: skill.name,
          version: skill.version,
          description: skill.description,
          requiresTools: skill.requiresTools,
          requiresProviders: skill.requiresProviders,
          minAutonomyLevel: skill.minAutonomyLevel,
          enabled,
          customPromptOverlay: org?.custom_prompt_overlay ?? null,
          config: org?.config ?? {},
          providerStatuses,
          missingProviders,
          assignedEmployees: assigned,
          computedStatus,
        };
      });

      return NextResponse.json({
        skills,
        employees: employeesRes.rows,
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const __scopedAuth = scopedAuthErrorResponse(error instanceof Error ? error : new Error(message));
    if (__scopedAuth) return __scopedAuth;
    console.error('API /api/skills GET Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
