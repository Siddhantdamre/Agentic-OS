import { DEFAULT_PUBLIC_ERROR, publicErrorMessage } from '@/lib/public-error';

export const DEFAULT_CLIENT_ERROR = DEFAULT_PUBLIC_ERROR;

type FailedResponse = { status: number; json: () => Promise<unknown> };

/**
 * One plain sentence for a failed request. Never throws (an empty or non-JSON body is common on a 5xx) and
 * never shows internals: the server's own sentence is used only when it is safe to show a customer.
 */
export async function responseErrorMessage(res: FailedResponse, fallback: string = DEFAULT_CLIENT_ERROR): Promise<string> {
  if (res.status === 429) return 'You’re going a little fast. Please wait a moment and try again.';
  let text = '';
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown } | null;
    if (body && typeof body === 'object') {
      if (typeof body.message === 'string') text = body.message;
      else if (typeof body.error === 'string') text = body.error;
    }
  } catch {
    /* empty or non-JSON body: use the fallback */
  }
  if (res.status === 401 && !text) return 'Your session has ended. Please sign in again.';
  if (res.status === 401 && /unauthori[sz]ed/i.test(text)) return 'Your session has ended. Please sign in again.';
  return publicErrorMessage(text, fallback);
}

export const NETWORK_ERROR = 'We couldn’t reach the server. Please check your connection and try again.';

const BROWSER_NETWORK_WORDING = /failed to fetch|networkerror|load failed|network request failed/i;

/**
 * The sentence for a caught error. A dropped connection surfaces in the browser as `TypeError: Failed to
 * fetch` (or "Load failed" in Safari); that must never reach a customer. One of our own sentences is kept,
 * and anything with internals in it is replaced by `fallback`.
 */
export function networkErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof TypeError || (err instanceof Error && BROWSER_NETWORK_WORDING.test(err.message))) return NETWORK_ERROR;
  return err instanceof Error ? publicErrorMessage(err, fallback) : fallback;
}
