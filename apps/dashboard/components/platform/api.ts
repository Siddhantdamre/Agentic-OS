import type {
  ImpersonationCurrent,
  PlatformObservability,
  PlatformOrgDetail,
  PlatformOrgRow,
  PlatformOverrides,
  PlatformRole,
} from './types';
import { MIN_REASON_LENGTH } from './types';

export type PlatformFetchError = {
  status: number;
  message: string;
  forbidden: boolean;
  notFound: boolean;
  migrationMissing: boolean;
};

export type PlatformResult<T> =
  | { ok: true; data: T; platformRole: PlatformRole | null }
  | { ok: false; error: PlatformFetchError };

function extractRole(json: unknown): PlatformRole | null {
  if (!json || typeof json !== 'object') return null;
  const role = (json as { platformRole?: unknown; platform_role?: unknown }).platformRole
    ?? (json as { platform_role?: unknown }).platform_role;
  if (role === 'operator' || role === 'support') return role;
  return null;
}

function classifyError(status: number, message: string): PlatformFetchError {
  const lower = message.toLowerCase();
  const migrationMissing =
    status === 500 ||
    status === 503 ||
    lower.includes('does not exist') ||
    lower.includes('relation') ||
    lower.includes('migration') ||
    lower.includes('platform_admins') ||
    lower.includes('undefined_table');
  return {
    status,
    message: message || `Request failed (${status})`,
    forbidden: status === 403,
    notFound: status === 404,
    migrationMissing: migrationMissing && status !== 403 && status !== 401,
  };
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function errorMessage(json: unknown, fallback: string): string {
  if (json && typeof json === 'object' && 'error' in json) {
    const err = (json as { error: unknown }).error;
    if (typeof err === 'string' && err.trim()) return err;
  }
  return fallback;
}

export async function platformGet<T>(
  path: string
): Promise<PlatformResult<T>> {
  try {
    const res = await fetch(path, { cache: 'no-store', credentials: 'same-origin' });
    const json = await parseJson(res);
    if (!res.ok) {
      return {
        ok: false,
        error: classifyError(res.status, errorMessage(json, `Failed (${res.status})`)),
      };
    }
    return { ok: true, data: json as T, platformRole: extractRole(json) };
  } catch (err) {
    return {
      ok: false,
      error: classifyError(
        0,
        err instanceof Error ? err.message : 'Network error'
      ),
    };
  }
}

export async function platformMutate(
  path: string,
  options: {
    method?: 'POST' | 'PUT' | 'PATCH';
    body?: Record<string, unknown>;
    reason: string;
  }
): Promise<PlatformResult<unknown>> {
  const reason = options.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      error: classifyError(
        400,
        `Reason must be at least ${MIN_REASON_LENGTH} characters`
      ),
    };
  }
  try {
    const res = await fetch(path, {
      method: options.method ?? 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(options.body ?? {}),
        confirm: true,
        reason,
      }),
    });
    const json = await parseJson(res);
    if (!res.ok) {
      return {
        ok: false,
        error: classifyError(res.status, errorMessage(json, `Failed (${res.status})`)),
      };
    }
    return { ok: true, data: json, platformRole: extractRole(json) };
  } catch (err) {
    return {
      ok: false,
      error: classifyError(
        0,
        err instanceof Error ? err.message : 'Network error'
      ),
    };
  }
}

type OrgsListPayload = {
  orgs?: PlatformOrgRow[];
  items?: PlatformOrgRow[];
  results?: PlatformOrgRow[];
  platformRole?: PlatformRole;
};

export async function fetchPlatformOrgs(): Promise<
  PlatformResult<{ orgs: PlatformOrgRow[]; platformRole: PlatformRole | null }>
> {
  const result = await platformGet<OrgsListPayload>('/api/platform/orgs');
  if (!result.ok) return result;
  const orgs = result.data.orgs ?? result.data.items ?? result.data.results ?? [];
  return {
    ok: true,
    data: { orgs: Array.isArray(orgs) ? orgs : [], platformRole: result.platformRole },
    platformRole: result.platformRole,
  };
}

export async function searchPlatformOrgs(
  q: string
): Promise<PlatformResult<{ orgs: PlatformOrgRow[]; platformRole: PlatformRole | null }>> {
  const result = await platformGet<OrgsListPayload>(
    `/api/platform/search?q=${encodeURIComponent(q)}`
  );
  if (!result.ok) return result;
  const orgs = result.data.orgs ?? result.data.items ?? result.data.results ?? [];
  return {
    ok: true,
    data: { orgs: Array.isArray(orgs) ? orgs : [], platformRole: result.platformRole },
    platformRole: result.platformRole,
  };
}

export async function fetchPlatformOrg(
  orgId: string
): Promise<PlatformResult<PlatformOrgDetail>> {
  return platformGet<PlatformOrgDetail>(`/api/platform/orgs/${encodeURIComponent(orgId)}`);
}

export async function fetchPlatformObservability(): Promise<
  PlatformResult<PlatformObservability>
> {
  return platformGet<PlatformObservability>('/api/platform/observability');
}

export async function fetchImpersonationCurrent(): Promise<ImpersonationCurrent> {
  try {
    const res = await fetch('/api/platform/impersonation/current', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!res.ok) return { active: false };
    const json = (await res.json()) as ImpersonationCurrent;
    return json?.active ? json : { active: false };
  } catch {
    return { active: false };
  }
}

export async function endImpersonation(reason: string): Promise<PlatformResult<unknown>> {
  return platformMutate('/api/platform/impersonation/end', { reason });
}

export async function startImpersonation(body: {
  targetUserId: string;
  targetOrgId: string;
  reason: string;
  breakGlass?: boolean;
}): Promise<PlatformResult<unknown>> {
  return platformMutate('/api/platform/impersonation', {
    body: {
      targetUserId: body.targetUserId,
      targetOrgId: body.targetOrgId,
      breakGlass: Boolean(body.breakGlass),
    },
    reason: body.reason,
  });
}

export async function putOrgOverrides(
  orgId: string,
  overrides: PlatformOverrides,
  reason: string
): Promise<PlatformResult<unknown>> {
  return platformMutate(`/api/platform/orgs/${encodeURIComponent(orgId)}/overrides`, {
    method: 'PUT',
    body: {
      seatCap: overrides.seatCap ?? null,
      meterCaps: overrides.meterCaps ?? {},
      featureFlags: overrides.featureFlags ?? {},
    },
    reason,
  });
}

export function stripeCustomerUrl(customerId: string | null | undefined): string | null {
  if (!customerId) return null;
  return `https://dashboard.stripe.com/customers/${encodeURIComponent(customerId)}`;
}

export function razorpaySubscriptionUrl(
  subscriptionId: string | null | undefined
): string | null {
  if (!subscriptionId) return null;
  return `https://dashboard.razorpay.com/app/subscriptions/${encodeURIComponent(subscriptionId)}`;
}

export function canOperate(role: PlatformRole | null): boolean {
  return role === 'operator';
}

export function isSupportOnly(role: PlatformRole | null): boolean {
  return role === 'support';
}
