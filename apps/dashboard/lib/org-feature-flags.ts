/**
 * Session-org feature flags from org_plan_overrides.
 *
 * Does not disable RLS, platform_audit_ok, or confirm gates — those are not
 * flags. Unknown / missing table (42P01) → empty object.
 */
import { getScopedClient } from '@/lib/db';
import {
  isFeatureFlagKey,
  PLATFORM_FEATURE_FLAG_REGISTRY,
  type PlatformFeatureFlagKey,
} from '@/lib/platform-admin';

export type OrgFeatureFlags = Partial<Record<PlatformFeatureFlagKey, boolean>>;

/** Normalize a raw JSONB map to allowed flag keys only. */
export function parseOrgFeatureFlags(raw: unknown): OrgFeatureFlags {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: OrgFeatureFlags = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isFeatureFlagKey(key)) continue;
    if (typeof value !== 'boolean') continue;
    out[key] = value;
  }
  return out;
}

export function isOrgFeatureFlagEnabled(
  flags: OrgFeatureFlags,
  key: PlatformFeatureFlagKey
): boolean {
  return flags[key] === true;
}

/**
 * Read feature_flags for the caller's session org.
 * Returns {} when the overrides table is missing (42P01) or no row exists.
 */
export async function getSessionOrgFeatureFlags(): Promise<OrgFeatureFlags> {
  let client: { release: () => void } | null = null;
  try {
    const scoped = await getScopedClient();
    client = scoped.client;
    const res = await scoped.client.query<{ feature_flags: unknown }>(
      `SELECT feature_flags
         FROM org_plan_overrides
        WHERE org_id = $1
        LIMIT 1`,
      [scoped.orgId]
    );
    return parseOrgFeatureFlags(res.rows[0]?.feature_flags);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    // undefined_table — migration 120 not applied
    if (code === '42P01') return {};
    throw err;
  } finally {
    client?.release();
  }
}

/** Allowed keys (for UI / docs). Same as PLATFORM_FEATURE_FLAG_REGISTRY. */
export const ORG_FEATURE_FLAG_KEYS = Object.keys(
  PLATFORM_FEATURE_FLAG_REGISTRY
) as PlatformFeatureFlagKey[];
