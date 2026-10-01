import { NextResponse } from 'next/server';
import { listOAuthProviders } from '@/lib/oauth-providers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/oauth — list available OAuth providers and their configuration status.
 */
export async function GET() {
  return NextResponse.json({
    providers: listOAuthProviders(),
  });
}
