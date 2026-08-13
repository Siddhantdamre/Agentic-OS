/**
 * Public widget embed auth (H6).
 * Stolen token cannot call database_query / Drive / admin APIs.
 * Until a pack is installed, auth is deny-all except token resolution.
 */
import { createHash } from 'crypto';
import { NextResponse } from 'next/server';
import { pool, getOrgScopedClient } from '@/lib/db';

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

export async function requireWidgetOrg(request: Request): Promise<
  { ok: true; orgId: string; token: string } | { ok: false; response: NextResponse }
> {
  const token = extractBearerToken(request);
  if (!token) return { ok: false, response: widgetUnauthorized() };
  const orgId = await resolveWidgetOrg(token);
  if (!orgId) return { ok: false, response: widgetUnauthorized() };
  return { ok: true, orgId, token };
}
