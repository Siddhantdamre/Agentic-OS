import { NextResponse } from 'next/server';

/** Parse JSON body safely — returns null on invalid JSON instead of throwing 500. */
export async function readJsonBody<T = Record<string, unknown>>(
  request: Request
): Promise<{ ok: true; body: T } | { ok: false; response: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'JSON body must be an object' }, { status: 400 }),
    };
  }
  return { ok: true, body: body as T };
}

/** Non-Response variant for routes that build their own error shape. */
export async function tryReadJson<T = Record<string, unknown>>(
  request: Request
): Promise<T | null> {
  try {
    const v = await request.json();
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as T;
  } catch {
    return null;
  }
}
