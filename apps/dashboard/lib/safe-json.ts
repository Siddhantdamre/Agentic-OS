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
  return { ok: true, body: stripNul(body) as T };
}

/** Non-Response variant for routes that build their own error shape. */
export async function tryReadJson<T = Record<string, unknown>>(
  request: Request
): Promise<T | null> {
  try {
    const v = await request.json();
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return stripNul(v) as T;
  } catch {
    return null;
  }
}

/**
 * The request body as a plain object — never throws, never returns null.
 *
 * Invalid JSON, an empty body, `null`, a bare number/string/boolean or an array all become `{}`, so the
 * route's own "field X is required" validation answers 400 instead of a destructuring TypeError
 * answering 500 (`null` is valid JSON, so `request.json().catch(() => ({}))` does not catch it).
 * NUL characters (\u0000) are removed from every string and key: they are valid JSON but Postgres
 * rejects them in both text and jsonb, which would otherwise surface as a 500 one layer down.
 */
// `any` by default, exactly like Request.json(), so call sites keep the typing they already had.
export async function jsonBodyOrEmpty<T = any>(request: Request): Promise<T> {
  try {
    const text = await request.text();
    if (!text.trim()) return {} as T;
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {} as T;
    return stripNul(parsed) as T;
  } catch {
    return {} as T;
  }
}

function stripNul(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
  if (Array.isArray(value)) return value.map(stripNul);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // defineProperty, not `out[k] = v`: assigning to "__proto__" would swap the object's prototype
      // (so `{"__proto__":{"isAdmin":true}}` would make `body.isAdmin` read true). JSON.parse keeps it
      // an inert own property; this does too.
      Object.defineProperty(out, k.includes('\u0000') ? k.replace(/\u0000/g, '') : k, {
        value: stripNul(v),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

/** Remove NUL characters from text that came from a URL (`?q=%00`): Postgres rejects them in text parameters. */
export function stripNulChars(value: string): string {
  return value.includes('\u0000') ? value.replace(/\u0000/g, '') : value;
}
