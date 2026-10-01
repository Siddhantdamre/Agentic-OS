import { NextResponse } from 'next/server';
import {
  featureFlagIsSafety,
  isFeatureFlagKey,
  isMeterKind,
  METER_KINDS,
  parseConfirmReason,
  PLATFORM_FEATURE_FLAG_REGISTRY,
  requireOperator,
  requirePlatformAdmin,
  type MeterKind,
  type PlatformFeatureFlagKey,
} from '@/lib/platform-admin';
import {
  platformErrorResponse,
  withPlatformTransaction,
} from '@/lib/platform-db';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ orgId: string }> };

type MeterCapValue = { soft?: number | null; hard?: number | null };

type OverridesBody = {
  confirm?: unknown;
  reason?: unknown;
  seat_cap?: number | null;
  seatCap?: number | null;
  meter_caps?: Record<string, MeterCapValue>;
  meterCaps?: Record<string, MeterCapValue>;
  feature_flags?: Record<string, boolean>;
  featureFlags?: Record<string, boolean>;
};

function normalizeMeterCaps(
  raw: Record<string, MeterCapValue> | undefined
): Record<MeterKind, { soft: number | null; hard: number | null }> | NextResponse {
  const out = {} as Record<MeterKind, { soft: number | null; hard: number | null }>;
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isMeterKind(key)) {
      return NextResponse.json(
        {
          error: 'invalid_meter_kind',
          message: `Unknown meter kind: ${key}`,
          allowed: METER_KINDS,
        },
        { status: 400 }
      );
    }
    if (!value || typeof value !== 'object') {
      return NextResponse.json(
        { error: 'invalid_meter_cap', message: `${key} must be { soft, hard }` },
        { status: 400 }
      );
    }
    out[key] = {
      soft: value.soft === undefined ? null : value.soft,
      hard: value.hard === undefined ? null : value.hard,
    };
  }
  return out;
}

function normalizeFeatureFlags(
  raw: Record<string, boolean> | undefined
): Record<PlatformFeatureFlagKey, boolean> | NextResponse {
  const out = {} as Record<PlatformFeatureFlagKey, boolean>;
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isFeatureFlagKey(key)) {
      return NextResponse.json(
        {
          error: 'unknown_feature_flag',
          message: `Unknown feature flag key: ${key}`,
          allowed: Object.keys(PLATFORM_FEATURE_FLAG_REGISTRY),
        },
        { status: 400 }
      );
    }
    if (typeof value !== 'boolean') {
      return NextResponse.json(
        { error: 'invalid_feature_flag', message: `${key} must be boolean` },
        { status: 400 }
      );
    }
    out[key] = value;
  }
  return out;
}

/**
 * PUT /api/platform/orgs/:orgId/overrides — writes org_plan_overrides via platform pool.
 * Raising a hard cap / seat_cap or setting a safety flag requires confirm:true.
 */
export async function PUT(request: Request, context: RouteContext) {
  try {
    const admin = await requirePlatformAdmin();
    if (admin instanceof NextResponse) return admin;
    const denied = requireOperator(admin);
    if (denied) return denied;

    const { orgId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as OverridesBody;

    const seatCapRaw = body.seat_cap !== undefined ? body.seat_cap : body.seatCap;
    let seatCap: number | null | undefined = undefined;
    if (seatCapRaw !== undefined) {
      if (seatCapRaw === null) {
        seatCap = null;
      } else if (typeof seatCapRaw === 'number' && Number.isInteger(seatCapRaw) && seatCapRaw >= 1) {
        seatCap = seatCapRaw;
      } else {
        return NextResponse.json(
          { error: 'invalid_seat_cap', message: 'seat_cap must be integer ≥ 1 or null' },
          { status: 400 }
        );
      }
    }

    const meterCaps = normalizeMeterCaps(body.meter_caps ?? body.meterCaps);
    if (meterCaps instanceof NextResponse) return meterCaps;

    const featureFlags = normalizeFeatureFlags(body.feature_flags ?? body.featureFlags);
    if (featureFlags instanceof NextResponse) return featureFlags;

    const needsConfirm =
      seatCap !== undefined ||
      Object.keys(meterCaps).length > 0 ||
      Object.keys(featureFlags).some((k) =>
        featureFlagIsSafety(k as PlatformFeatureFlagKey)
      ) ||
      Object.keys(featureFlags).length > 0;

    // Spec: raising hard cap / seat_cap / safety flag requires confirm — we
    // require confirm for any override write (same dialog class as kill switches).
    if (needsConfirm) {
      const parsed = parseConfirmReason(body);
      if (parsed instanceof NextResponse) return parsed;

      const row = await withPlatformTransaction(
        {
          actorUserId: admin.userId,
          platformRole: admin.platformRole,
          action: 'org.overrides',
          targetOrgId: orgId,
          targetTable: 'org_plan_overrides',
          targetRowId: orgId,
          reason: parsed.reason,
        },
        async (client) => {
          const existing = await client.query<{
            seat_cap: number | null;
            meter_caps: Record<string, MeterCapValue>;
            feature_flags: Record<string, boolean>;
          }>(
            `SELECT seat_cap, meter_caps, feature_flags
               FROM org_plan_overrides WHERE org_id = $1`,
            [orgId]
          );
          const prev = existing.rows[0];
          const nextSeat =
            seatCap !== undefined ? seatCap : (prev?.seat_cap ?? null);
          const nextMeters = {
            ...(prev?.meter_caps && typeof prev.meter_caps === 'object'
              ? prev.meter_caps
              : {}),
            ...meterCaps,
          };
          const nextFlags = {
            ...(prev?.feature_flags && typeof prev.feature_flags === 'object'
              ? prev.feature_flags
              : {}),
            ...featureFlags,
          };

          const res = await client.query(
            `INSERT INTO org_plan_overrides (
               org_id, meter_caps, feature_flags, seat_cap, reason, updated_by, updated_at
             ) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6, NOW())
             ON CONFLICT (org_id) DO UPDATE SET
               meter_caps = EXCLUDED.meter_caps,
               feature_flags = EXCLUDED.feature_flags,
               seat_cap = EXCLUDED.seat_cap,
               reason = EXCLUDED.reason,
               updated_by = EXCLUDED.updated_by,
               updated_at = NOW()
             RETURNING org_id, seat_cap, meter_caps, feature_flags, reason, updated_at`,
            [
              orgId,
              JSON.stringify(nextMeters),
              JSON.stringify(nextFlags),
              nextSeat,
              parsed.reason,
              admin.userId,
            ]
          );
          return res.rows[0];
        }
      );

      return NextResponse.json({
        ok: true,
        override: {
          orgId: row.org_id,
          seatCap: row.seat_cap,
          meterCaps: row.meter_caps,
          featureFlags: row.feature_flags,
          reason: row.reason,
          updatedAt: row.updated_at,
        },
      });
    }

    return NextResponse.json(
      { error: 'empty_override', message: 'No override fields provided' },
      { status: 400 }
    );
  } catch (err) {
    const platform = platformErrorResponse(err);
    if (platform) return platform;
    console.error('PUT /api/platform/orgs/[orgId]/overrides', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
