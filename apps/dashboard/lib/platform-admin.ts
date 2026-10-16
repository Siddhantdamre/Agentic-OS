/**
 * Platform admin gate for /api/platform/* routes.
 *
 * Looks up platform_admins on the normal darex_app pool (self-row RLS via
 * app.current_user_id). Never uses getScopedClient() to read another org.
 * Middleware only checks session presence; this helper enforces platform_role.
 */
import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { cookies } from 'next/headers';
import { pool } from '@/lib/db';
import { parseSessionCookieParts, SESSION_COOKIE } from '@/lib/session-cookie';
import { isPlatformSchemaMissing, type PlatformRole } from '@/lib/platform-db';

export const GENERIC_FORBIDDEN = { error: 'Forbidden' } as const;

/** Allowed org_plan_overrides.feature_flags keys. Unknown keys → 400. */
export const PLATFORM_FEATURE_FLAG_REGISTRY = {
  packs_install: { safety: false },
  crew_spawn: { safety: false },
  memory_write: { safety: false },
  external_web_tools: { safety: false },
  whatsapp_outbound: { safety: true },
  autonomous_send: { safety: true },
  autonomous_actions: { safety: true },
} as const;

export type PlatformFeatureFlagKey = keyof typeof PLATFORM_FEATURE_FLAG_REGISTRY;

export const METER_KINDS = [
  'llm_tokens',
  'whatsapp_conversations',
  'seats',
  'embeddings',
  'successful_actions',
  'disconnected_actions',
] as const;

export type MeterKind = (typeof METER_KINDS)[number];

export type PlatformAdmin = {
  userId: string;
  platformRole: PlatformRole;
};

const SENSITIVE_KEY_RE =
  /password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential/i;

/** Same redaction idea as GET /api/audit-logs. */
export function redactPayloadPreview(raw: unknown): string {
  let text: string;
  try {
    if (typeof raw === 'string') text = raw;
    else text = JSON.stringify(raw ?? {});
  } catch {
    text = '[unserializable]';
  }
  text = text.replace(
    /("?(?:password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|credential)"?\s*:\s*")([^"]*)(")/gi,
    '$1[redacted]$3'
  );
  if (SENSITIVE_KEY_RE.test(text) && text.length > 400) {
    return text.slice(0, 200) + '…';
  }
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
}

export function forbiddenResponse(): NextResponse {
  return NextResponse.json(GENERIC_FORBIDDEN, { status: 403 });
}

export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * Session cookie → user id → SELECT platform_role FROM platform_admins
 * WHERE user_id = current user (darex_app pool, self-row).
 */
export async function requirePlatformAdmin(
  _request?: Request
): Promise<PlatformAdmin | NextResponse> {
  const cookieStore = await cookies();
  const session = await parseSessionCookieParts(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session) {
    return unauthorizedResponse();
  }
  const { userId, epoch: cookieEpoch } = session;

  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_user_id', $1, false)", [userId]);
    // A revoked session (users.session_epoch bumped) must not still reach
    // the highest-privilege routes in the app just because its signature is
    // still valid — same check getScopedClient() already makes (SEC-A02).
    let sessionEpoch = 0;
    let disabled = false;
    try {
      const epochRes = await client.query<{ session_epoch: number; disabled: boolean }>(
        `SELECT session_epoch, (disabled_at IS NOT NULL) AS disabled FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      sessionEpoch = Number(epochRes.rows[0]?.session_epoch ?? 0);
      disabled = epochRes.rows[0]?.disabled === true;
    } catch (err: unknown) {
      // Column missing (42703) before migration 121 / 206 — treat as epoch 0, not disabled.
      if ((err as { code?: string })?.code !== '42703') throw err;
      sessionEpoch = 0;
    }
    if (cookieEpoch !== sessionEpoch || disabled) {
      return unauthorizedResponse();
    }
    const res = await client.query<{ platform_role: string }>(
      `SELECT platform_role
         FROM platform_admins
        WHERE user_id = $1
        LIMIT 1`,
      [userId]
    );
    const role = res.rows[0]?.platform_role;
    if (role !== 'operator' && role !== 'support') {
      return forbiddenResponse();
    }
    return { userId, platformRole: role };
  } catch (err) {
    if (isPlatformSchemaMissing(err)) {
      return NextResponse.json(
        {
          error: 'platform_migration_pending',
          message: 'Platform migration is not applied',
          detail: err instanceof Error ? err.message.slice(0, 200) : undefined,
        },
        { status: 503 }
      );
    }
    throw err;
  } finally {
    try {
      await client.query('RESET app.current_user_id');
    } catch {
      // release anyway
    }
    client.release();
  }
}

export function requireOperator(admin: PlatformAdmin): NextResponse | null {
  if (admin.platformRole !== 'operator') {
    return forbiddenResponse();
  }
  return null;
}

export type ConfirmBody = {
  confirm?: unknown;
  reason?: unknown;
};

export function parseConfirmReason(
  body: ConfirmBody,
  opts?: { minReason?: number }
): { confirm: true; reason: string } | NextResponse {
  const minReason = opts?.minReason ?? 12;
  if (body.confirm !== true) {
    return NextResponse.json(
      { error: 'confirm_required', message: 'Body must include confirm: true' },
      { status: 400 }
    );
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < minReason) {
    return NextResponse.json(
      {
        error: 'reason_required',
        message: `reason must be at least ${minReason} characters`,
      },
      { status: 400 }
    );
  }
  return { confirm: true, reason };
}

export function isMeterKind(value: string): value is MeterKind {
  return (METER_KINDS as readonly string[]).includes(value);
}

export function isFeatureFlagKey(value: string): value is PlatformFeatureFlagKey {
  return Object.prototype.hasOwnProperty.call(PLATFORM_FEATURE_FLAG_REGISTRY, value);
}

export function featureFlagIsSafety(key: PlatformFeatureFlagKey): boolean {
  return PLATFORM_FEATURE_FLAG_REGISTRY[key].safety;
}

export function paymentMethodLink(opts: {
  provider: string | null | undefined;
  providerCustomerId: string | null | undefined;
  providerSubscriptionId: string | null | undefined;
}): { provider: string; url: string } | null {
  const provider = (opts.provider || '').toLowerCase();
  if (provider === 'stripe') {
    if (!opts.providerCustomerId) return null;
    return {
      provider: 'stripe',
      url: `https://dashboard.stripe.com/customers/${encodeURIComponent(opts.providerCustomerId)}`,
    };
  }
  if (provider === 'razorpay') {
    if (!opts.providerSubscriptionId) return null;
    return {
      provider: 'razorpay',
      url: `https://dashboard.razorpay.com/app/subscriptions/${encodeURIComponent(opts.providerSubscriptionId)}`,
    };
  }
  return null;
}

export const IMPERSONATION_COOKIE = 'darex_impersonation';
export const IMPERSONATION_MAX_MINUTES = 30;

export async function withAppUserGuc<T>(
  userId: string,
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.current_user_id', $1, false)", [userId]);
    return await work(client);
  } finally {
    try {
      await client.query('RESET app.current_user_id');
    } catch {
      // ignore
    }
    client.release();
  }
}
