import { NextRequest, NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { buildMcpTenantHeaders } from '@darex/workflows/dist/trueforge-client';
import type { AgentTaskInput } from '@darex/shared-types';

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
  const tfBase = getTrueforgeUrl();
  const search = req.nextUrl.search;
  const targetUrl = `${tfBase}/${path.join('/')}${search}`;

  let orgId: string | undefined;
  let userId: string | undefined;
  try {
    const scoped = await getScopedClient();
    orgId = scoped.orgId;
    userId = scoped.userId;
    scoped.client.release();
  } catch {
    // Unauthenticated or in demo mode
  }

  const forwardHeaders = new Headers();
  for (const [key, value] of req.headers.entries()) {
    const lk = key.toLowerCase();
    if (lk === 'host' || lk === 'connection' || lk === 'content-length') continue;
    forwardHeaders.set(key, value);
  }

  if (orgId) {
    const taskInput: AgentTaskInput = {
      orgId,
      userId: userId || '',
      employeeName: 'darex-ai',
      employeeRole: 'General Assistant',
      employeePersona: 'Autonomous business assistant',
      toolAllowlist: [],
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

    const resHeaders = new Headers();
    for (const [key, value] of res.headers.entries()) {
      resHeaders.set(key, value);
    }

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
