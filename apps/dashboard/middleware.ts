import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { denyOrgApiIfLimited } from '@/lib/rate-limit-core';
import {
  ONBOARDING_COOKIE,
  ORG_COOKIE,
  SESSION_COOKIE,
  isAuthenticatedPublicPath,
  isPublicApiPath,
  isPublicAuthPath,
  isUuid,
  parseSessionCookie,
} from '@/lib/session-cookie';

/**
 * Platform console (`/admin`, `/api/platform/*`):
 * Middleware is Edge and cannot query Postgres. It only requires a signed
 * session cookie. Route handlers call requirePlatformAdmin() which SELECTs
 * platform_admins on the darex_app pool (self-row). Non-admins get a generic
 * 403 on the API; the UI route group returns 404 for the page.
 */
function isPlatformAdminPage(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

function isHealthApiPath(pathname: string): boolean {
  return pathname === '/api/health' || pathname === '/api/health/ready';
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isApiRoute = pathname.startsWith('/api/');
  // API routes always go through auth — never treat them as static assets,
  // even if they contain a dot (e.g. /api/conversations.json).
  // Only real file assets (trailing extension) skip auth, and only for pages.
  const isStaticAsset =
    !isApiRoute &&
    (pathname.startsWith('/_next') ||
      pathname.startsWith('/favicon.ico') ||
      /\.[a-zA-Z0-9]{1,8}$/.test(pathname));

  if (isStaticAsset) {
    return NextResponse.next();
  }

  const rawSession = request.cookies.get(SESSION_COOKIE)?.value;
  const userId = await parseSessionCookie(rawSession);
  const hasSession = !!userId;
  const needsOnboarding = request.cookies.get(ONBOARDING_COOKIE)?.value === '1';
  const adminPage = isPlatformAdminPage(pathname);

  if (isApiRoute) {
    // /api/platform/*: no session → 401 (same as other protected APIs).
    // platform_admins role is checked inside each route via requirePlatformAdmin.
    if (!hasSession && !isPublicApiPath(pathname)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // Edge quota: prefer active workspace org cookie, else session user id.
    // ORG_COOKIE is a hint; the DB org pointer remains the authority for data access.
    // Health probes stay unlimited. Public unauthenticated routes keep IP/auth limiters.
    if (hasSession && userId && !isHealthApiPath(pathname)) {
      const orgCookie = request.cookies.get(ORG_COOKIE)?.value?.trim();
      const rateLimitKey = orgCookie && isUuid(orgCookie) ? orgCookie : userId;
      const limited = denyOrgApiIfLimited(rateLimitKey);
      if (limited) return limited;
    }
    return NextResponse.next();
  }

  const isPublicPage = isPublicAuthPath(pathname);
  const isOnboarding = pathname.startsWith('/onboarding');

  // /admin and all other non-public pages: no session → redirect to login.
  if (!hasSession && !isPublicPage) {
    const loginUrl = new URL('/login', request.url);
    if (pathname !== '/') {
      loginUrl.searchParams.set('redirect', pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  if (hasSession && isPublicPage) {
    if (isAuthenticatedPublicPath(pathname)) {
      return NextResponse.next();
    }
    if (needsOnboarding) {
      return NextResponse.redirect(new URL('/onboarding/name', request.url));
    }
    return NextResponse.redirect(new URL('/', request.url));
  }

  // Operators may open /admin even when their personal org still needs onboarding.
  if (
    hasSession &&
    needsOnboarding &&
    !isOnboarding &&
    !isAuthenticatedPublicPath(pathname) &&
    !adminPage
  ) {
    return NextResponse.redirect(new URL('/onboarding/name', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
