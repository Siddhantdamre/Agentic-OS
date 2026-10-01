import { NextResponse } from 'next/server';
import { collectRuntimeTelemetry } from '@/lib/runtime-telemetry';

export const dynamic = 'force-dynamic';

/** Liveness probe for compose / load balancers. Does not require a session. */
export async function GET() {
  const runtime = await collectRuntimeTelemetry();
  return NextResponse.json({
    ok: true,
    service: 'dashboard',
    runtime,
  });
}
