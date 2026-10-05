/**
 * Header and path hygiene for the TrueForge proxy (app/api/trueforge/[...path]).
 *
 * The proxy signs requests on behalf of the signed-in tenant. It must not let the caller write the tenant's
 * identity, must not forward the caller's own credentials to the upstream service, and must return plain
 * content (no upstream cookies; no encoding or length headers that describe a body the fetch layer has
 * already decoded).
 */

const REQUEST_DROP = new Set([
  // tenant identity: only the session may set these (the route re-adds them after this runs)
  'x-org-id',
  'x-user-id',
  'x-tfg-mcp-headers',
  // the caller's credentials are for this app, not for the upstream service
  'cookie',
  'authorization',
  'proxy-authorization',
  // hop-by-hop and framing
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'keep-alive',
  'proxy-connection',
]);

const RESPONSE_DROP = new Set([
  'set-cookie',
  'set-cookie2',
  // fetch has decoded the body: these no longer describe it
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'trailer',
  'upgrade',
]);

function copyExcept(source: Headers, drop: Set<string>): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!drop.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

export function sanitizeForwardHeaders(incoming: Headers): Headers {
  return copyExcept(incoming, REQUEST_DROP);
}

export function sanitizeResponseHeaders(upstream: Headers): Headers {
  return copyExcept(upstream, RESPONSE_DROP);
}

/** False for any segment that could climb out of the intended path or smuggle control characters. */
export function isSafeProxyPath(segments: string[]): boolean {
  return segments.every((segment) => {
    if (/[\u0000-\u001f\u007f\\]/.test(segment)) return false;
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (/[\u0000-\u001f\u007f\\]/.test(decoded)) return false;
    return !decoded.split('/').some((part) => part === '.' || part === '..');
  });
}
