import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  ONBOARDING_COOKIE,
  SESSION_COOKIE,
  isAuthenticatedPublicPath,
  isPublicApiPath,
  isPublicAuthPath,
  parseSessionCookie,
} from '@/lib/session-cookie';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isApiRoute = pathname.startsWith('/api/');
  const isStaticAsset =
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon.ico') ||
    pathname.includes('.');

  if (isStaticAsset) {
    return NextResponse.next();
  }

  const rawSession = request.cookies.get(SESSION_COOKIE)?.value;
  const userId = await parseSessionCookie(rawSession);
  const hasSession = !!userId;
  const needsOnboarding = request.cookies.get(ONBOARDING_COOKIE)?.value === '1';

  if (isApiRoute) {
    if (!hasSession && !isPublicApiPath(pathname)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.next();
  }

  const isPublicPage = isPublicAuthPath(pathname);
  const isOnboarding = pathname.startsWith('/onboarding');

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

  if (hasSession && needsOnboarding && !isOnboarding && !isAuthenticatedPublicPath(pathname)) {
    return NextResponse.redirect(new URL('/onboarding/name', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
