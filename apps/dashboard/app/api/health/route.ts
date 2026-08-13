import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Liveness probe for compose / load balancers. Does not require a session. */
export async function GET() {
  return NextResponse.json({ ok: true, service: 'dashboard' });
}
