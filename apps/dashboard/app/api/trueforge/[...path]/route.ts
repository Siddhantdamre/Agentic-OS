import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { buildMcpTenantHeaders } from '@darex/workflows/dist/trueforge-client';
import type { AgentTaskInput } from '@darex/shared-types';
import { isSafeProxyPath, sanitizeForwardHeaders, sanitizeResponseHeaders } from '@/lib/trueforge-proxy-headers';

export const dynamic = 'force-dynamic';

function getTrueforgeUrl(): string {
  return (
    process.env.TRUEFORGE_URL ||
    process.env.TRUEFOUNDRY_SERVER_URL ||
    (process.env.NODE_ENV === 'production' ? 'http://trueforge:8790' : 'http://localhost:8790')
  );
}

async function proxyToTrueforge(
  req: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  const { path = [] } = await params;
  if (!isSafeProxyPath(path)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }
  const tfBase = getTrueforgeUrl();
  const search = req.nextUrl.search;
  const targetUrl = `${tfBase}/${path.join('/')}${search}`;

  let orgId: string | undefined;
  let userId: string | undefined;
  let activeRole = 'Executive';
  let activeName = 'darex-ai';
  let allowlist: string[] = [];

  try {
    const scoped = await getScopedClient();
    orgId = scoped.orgId;
    userId = scoped.userId;

    try {
      const requestedRole = req.headers.get('x-employee-role') || req.nextUrl.searchParams.get('employee_role');
      const requestedId = req.headers.get('x-employee-id') || req.nextUrl.searchParams.get('employee_id');

      let query = `
        SELECT id, name, role, tool_allowlist
        FROM ai_employees
        WHERE org_id = $1 AND status = 'active' AND archived_at IS NULL
      `;
      const queryParams: any[] = [orgId];

      if (requestedId) {
        query += ` AND id = $2`;
        queryParams.push(requestedId);
      } else if (requestedRole) {
        query += ` AND LOWER(role) = LOWER($2)`;
        queryParams.push(requestedRole);
      } else {
        query += ` ORDER BY (role = 'Executive') DESC, created_at ASC LIMIT 1`;
      }

      const empRes = await scoped.client.query(query, queryParams);
      if (empRes.rows.length > 0) {
        activeRole = empRes.rows[0].role;
        activeName = empRes.rows[0].name;
        if (Array.isArray(empRes.rows[0].tool_allowlist)) {
          allowlist = empRes.rows[0].tool_allowlist;
        }
      }
    } catch (dbErr) {
      console.warn('[trueforge-proxy] employee lookup failed:', dbErr);
    } finally {
      scoped.client.release();
    }
  } catch {
    // Unauthenticated or in demo mode
  }

  // Identity headers and the caller's credentials are dropped first; the session's own identity is added below.
  const forwardHeaders = sanitizeForwardHeaders(req.headers);

  if (orgId) {
    const taskInput: AgentTaskInput = {
      orgId,
      userId: userId || '',
      employeeName: activeName,
      employeeRole: activeRole,
      employeePersona: 'Autonomous business assistant',
      toolAllowlist: allowlist,
      userMessage: '',
    };
    const tenantHeaders = buildMcpTenantHeaders(taskInput);
    forwardHeaders.set('x-org-id', orgId);
    if (userId) forwardHeaders.set('x-user-id', userId);
    forwardHeaders.set('x-tfg-mcp-headers', JSON.stringify({ darex: tenantHeaders }));
  }

  const init: RequestInit & { duplex?: string } = {
    method: req.method,
    headers: forwardHeaders,
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
    init.duplex = 'half';
  }

  try {
    const res = await fetch(targetUrl, init);

    const resHeaders = sanitizeResponseHeaders(res.headers);

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
    });
  } catch (err: any) {
    console.error('[trueforge-proxy] Error proxying to TrueForge:', err?.message || err);
    return NextResponse.json(
      { error: 'Failed to connect to TrueForge agent service' },
      { status: 502 }
    );
  }
}

export const GET = proxyToTrueforge;
export const POST = proxyToTrueforge;
export const PUT = proxyToTrueforge;
export const DELETE = proxyToTrueforge;
export const PATCH = proxyToTrueforge;
export const OPTIONS = proxyToTrueforge;
