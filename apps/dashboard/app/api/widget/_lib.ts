/**
 * Public widget embed auth (H6).
 * Stolen token cannot call database_query / Drive / admin APIs.
 * Until a pack is installed, auth is deny-all except token resolution.
 * Tenant comes from the site key hash — body org_id is ignored.
 */
import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { pool, getOrgScopedClient } from '@/lib/db';
import { parseAllowedOrigins } from '@/lib/widget-embed';

export const WIDGET_ALLOWLIST = ['listings.search'] as const;
export type WidgetAllowlistedTool = (typeof WIDGET_ALLOWLIST)[number];

export type WidgetToolKind = WidgetAllowlistedTool | 'denied';

export function hashWidgetToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get('authorization') || '';
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  const url = new URL(request.url);
  const q = url.searchParams.get('token') || url.searchParams.get('embed_token');
  return q && q.trim() ? q.trim() : null;
}

/** Public JSON bodies may include org_id; never use it for tenancy. */
export function ignoreBodyOrgId(body: Record<string, unknown> | null | undefined): void {
  if (!body) return;
  void body.org_id;
  void body.orgId;
  void body.organizationId;
}

export async function resolveWidgetOrg(token: string): Promise<string | null> {
  const tokenHash = hashWidgetToken(token);
  try {
    const res = await pool.query(`SELECT resolve_widget_org_by_token_hash($1) AS id`, [tokenHash]);
    if (res.rows[0]?.id) return res.rows[0].id as string;
  } catch {
    const res = await pool.query(
      `SELECT org_id FROM widget_embed_tokens WHERE token_hash = $1 AND status = 'active' LIMIT 1`,
      [tokenHash]
    );
    if (res.rows[0]?.org_id) return res.rows[0].org_id as string;
  }
  try {
    const chan = await pool.query(
      `SELECT org_id FROM channels
        WHERE channel_type = 'widget'
          AND (
            meta->>'embed_token_hash' = $1
            OR meta->>'token_hash' = $1
          )
        LIMIT 1`,
      [tokenHash]
    );
    return (chan.rows[0]?.org_id as string) || null;
  } catch {
    return null;
  }
}

export async function loadWidgetAllowedOrigins(orgId: string): Promise<string[]> {
  const { client } = await getOrgScopedClient(orgId);
  try {
    const res = await client.query(
      `SELECT meta FROM channels WHERE org_id = $1 AND channel_type = 'widget' LIMIT 1`,
      [orgId]
    );
    const meta = (res.rows[0]?.meta || {}) as Record<string, unknown>;
    return parseAllowedOrigins(meta.allowed_origins);
  } catch {
    return [];
  } finally {
    client.release();
  }
}

export function requestOrigin(request: Request): string | null {
  const origin = (request.headers.get('origin') || '').trim();
  return origin || null;
}

export function originAllowed(origin: string | null, allowlist: string[]): boolean {
  if (!origin) return true;
  if (allowlist.length === 0 || allowlist.includes('*')) return true;
  return allowlist.includes(origin);
}

export function applyWidgetCors(request: Request, headers: Headers, allowedOrigins?: string[]): void {
  const origin = requestOrigin(request);
  if (!origin) return;
  const list = allowedOrigins || [];
  if (list.length > 0 && !list.includes('*') && !list.includes(origin)) return;
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Vary', 'Origin');
}

export function withWidgetCors(
  request: Request,
  response: Response,
  allowedOrigins?: string[]
): NextResponse {
  const headers = new Headers(response.headers);
  applyWidgetCors(request, headers, allowedOrigins);
  return new NextResponse(response.body, { status: response.status, headers });
}

export function widgetPreflight(request: Request): NextResponse {
  const res = new NextResponse(null, { status: 204 });
  applyWidgetCors(request, res.headers, ['*']);
  return res;
}

export async function orgHasInstalledPack(orgId: string): Promise<boolean> {
  const { client } = await getOrgScopedClient(orgId);
  try {
    const res = await client.query(
      `SELECT 1 FROM org_packs WHERE org_id = $1 AND status = 'installed' LIMIT 1`,
      [orgId]
    );
    return res.rows.length > 0;
  } catch {
    return false;
  } finally {
    client.release();
  }
}

export function normalizeWidgetTool(raw: string | null | undefined): WidgetToolKind {
  const n = (raw || '').trim().toLowerCase().replace(/_/g, '.');
  switch (n) {
    case 'listings.search':
    case 'listings.search.list':
    case 're.listings.search':
      return 'listings.search';
    default:
      return 'denied';
  }
}

export function isDeniedAdminTool(raw: string | null | undefined): boolean {
  const n = (raw || '').trim().toLowerCase();
  return (
    n.includes('database') ||
    n.includes('drive') ||
    n.includes('sql') ||
    n.includes('billing') ||
    n.includes('employee') ||
    n.includes('dsr') ||
    n.includes('audit') ||
    n.includes('brain') ||
    n.includes('ask-ai') ||
    n.includes('ask_ai') ||
    n.includes('google-drive') ||
    n.includes('google_drive')
  );
}

export function widgetUnauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized', connected: false }, { status: 401 });
}

export function widgetForbidden(message: string): NextResponse {
  return NextResponse.json(
    { error: message, connected: false, allowlist: WIDGET_ALLOWLIST },
    { status: 403 }
  );
}

export type WidgetAuthOk = { ok: true; orgId: string; token: string; allowedOrigins: string[] };
export type WidgetAuthErr = { ok: false; response: NextResponse };

export async function requireWidgetOrg(request: Request): Promise<WidgetAuthOk | WidgetAuthErr> {
  const token = extractBearerToken(request);
  if (!token) {
    return { ok: false, response: withWidgetCors(request, widgetUnauthorized(), ['*']) };
  }
  const orgId = await resolveWidgetOrg(token);
  if (!orgId) {
    return { ok: false, response: withWidgetCors(request, widgetUnauthorized(), ['*']) };
  }
  const allowedOrigins = await loadWidgetAllowedOrigins(orgId);
  const origin = requestOrigin(request);
  if (!originAllowed(origin, allowedOrigins)) {
    return {
      ok: false,
      response: withWidgetCors(
        request,
        NextResponse.json({ error: 'Forbidden', connected: false }, { status: 403 }),
        allowedOrigins
      ),
    };
  }
  return { ok: true, orgId, token, allowedOrigins };
}
