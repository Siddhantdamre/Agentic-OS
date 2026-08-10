import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Never intercept these
  const isApiRoute = pathname.startsWith('/api/');
  const isStaticAsset =
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon.ico') ||
    pathname.includes('.');

  if (isApiRoute || isStaticAsset) {
    return NextResponse.next();
  }

  // Public auth pages that don't require a session
  const isPublicAuthPage =
    pathname === '/login' ||
    pathname === '/register' ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/register');

  // Read session cookie
  const sessionCookie = request.cookies.get('darex_session')?.value;
  const hasSession = !!sessionCookie && sessionCookie.trim().length > 0;

  // 1. Unauthenticated user accessing protected route → redirect to login
  if (!hasSession && !isPublicAuthPage) {
    const loginUrl = new URL('/login', request.url);
    // Preserve the intended destination so we can redirect after login
    if (pathname !== '/') {
      loginUrl.searchParams.set('redirect', pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  // 2. Authenticated user hitting login/register → redirect to dashboard
  if (hasSession && isPublicAuthPage) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  // 3. Authenticated user on dashboard with no org cookie — dashboard/API provisions org on first call
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
