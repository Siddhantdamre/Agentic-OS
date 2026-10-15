/**
 * One id per request, sent back as X-Request-Id. A person can quote it to support and a log line can be found by it.
 * An id sent by a proxy is kept when it is short and plain; anything else is replaced, because it ends up in logs.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

const SAFE = /^[A-Za-z0-9_-]{1,64}$/;

export function requestIdFor(incoming: string | null | undefined): string {
  if (incoming && SAFE.test(incoming)) return incoming;
  return crypto.randomUUID();
}
