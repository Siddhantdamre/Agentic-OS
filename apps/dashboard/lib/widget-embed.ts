/**
 * H6 public widget helpers. The site key is a public embed token (hashed at rest).
 * Tenant is always resolved from the key hash — never from a request body org_id.
 */
import type { PoolClient } from 'pg';
import { randomToken, sha256Hex } from '@/lib/password';

export function publicAppUrl(fallbackOrigin?: string): string {
  const fromEnv = (process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  return (fallbackOrigin || 'http://localhost:3000').replace(/\/$/, '');
}

export function widgetScriptSrc(appUrl = publicAppUrl()): string {
  return `${appUrl}/embed/widget.js`;
}

export function widgetEmbedSnippet(siteKey: string, appUrl = publicAppUrl()): string {
  return `<script src="${widgetScriptSrc(appUrl)}" data-site-key="${siteKey}" async></script>`;
}

export function parseAllowedOrigins(raw: unknown): string[] {
  const parts: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') parts.push(item);
    }
  } else if (typeof raw === 'string') {
    parts.push(...raw.split(/[\n,]+/));
  }
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed === '*') {
      out.push('*');
      continue;
    }
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      out.push(url.origin);
    } catch {
      continue;
    }
  }
  return [...new Set(out)];
}

export type WidgetSettingsView = {
  siteKey: string | null;
  hasActiveKey: boolean;
  snippet: string | null;
  scriptSrc: string;
  allowedOrigins: string[];
  hasPack: boolean;
};

export async function loadWidgetSettings(
  client: PoolClient,
  orgId: string,
  appUrl?: string
): Promise<WidgetSettingsView> {
  const base = publicAppUrl(appUrl);
  const chan = await client.query(
    `SELECT meta FROM channels WHERE org_id = $1 AND channel_type = 'widget' LIMIT 1`,
    [orgId]
  );
  const token = await client.query(
    `SELECT 1 FROM widget_embed_tokens WHERE org_id = $1 AND status = 'active' LIMIT 1`,
    [orgId]
  );
  let hasPack = false;
  try {
    const pack = await client.query(
      `SELECT 1 FROM org_packs WHERE org_id = $1 AND status = 'installed' LIMIT 1`,
      [orgId]
    );
    hasPack = pack.rows.length > 0;
  } catch {
    hasPack = false;
  }
  const meta = (chan.rows[0]?.meta || {}) as Record<string, unknown>;
  const siteKey = typeof meta.site_key === 'string' && meta.site_key.trim() ? meta.site_key.trim() : null;
  const hasActiveKey = token.rows.length > 0;
  return {
    siteKey,
    hasActiveKey,
    snippet: siteKey ? widgetEmbedSnippet(siteKey, base) : null,
    scriptSrc: widgetScriptSrc(base),
    allowedOrigins: parseAllowedOrigins(meta.allowed_origins),
    hasPack,
  };
}

export async function rotateWidgetSiteKey(
  client: PoolClient,
  orgId: string,
  appUrl?: string
): Promise<{ siteKey: string; snippet: string; scriptSrc: string; allowedOrigins: string[] }> {
  const siteKey = `dxw_${randomToken()}`;
  const tokenHash = sha256Hex(siteKey);
  const existing = await loadWidgetSettings(client, orgId, appUrl);
  const allowedOrigins = existing.allowedOrigins;
  await client.query(
    `UPDATE widget_embed_tokens SET status = 'revoked' WHERE org_id = $1 AND status = 'active'`,
    [orgId]
  );
  await client.query(
    `INSERT INTO widget_embed_tokens (org_id, token_hash, status) VALUES ($1, $2, 'active')`,
    [orgId, tokenHash]
  );
  const meta = {
    name: 'Widget Channel',
    site_key: siteKey,
    embed_token_hash: tokenHash,
    allowed_origins: allowedOrigins,
  };
  await client.query(
    `INSERT INTO channels (org_id, channel_type, status, meta, connected_at)
     VALUES ($1, 'widget', 'active', $2::jsonb, NOW())
     ON CONFLICT (org_id, channel_type)
     DO UPDATE SET
       status = 'active',
       meta = COALESCE(channels.meta, '{}'::jsonb) || EXCLUDED.meta,
       updated_at = NOW()`,
    [orgId, JSON.stringify(meta)]
  );
  const base = publicAppUrl(appUrl);
  return {
    siteKey,
    snippet: widgetEmbedSnippet(siteKey, base),
    scriptSrc: widgetScriptSrc(base),
    allowedOrigins,
  };
}

export async function updateWidgetAllowedOrigins(
  client: PoolClient,
  orgId: string,
  origins: string[]
): Promise<{ allowedOrigins: string[] }> {
  const allowedOrigins = parseAllowedOrigins(origins);
  const updated = await client.query(
    `UPDATE channels
        SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{allowed_origins}', $2::jsonb, true),
            updated_at = NOW()
      WHERE org_id = $1 AND channel_type = 'widget'
      RETURNING id`,
    [orgId, JSON.stringify(allowedOrigins)]
  );
  if (updated.rows.length === 0) {
    throw new Error('Generate a widget site key before saving origins.');
  }
  return { allowedOrigins };
}
