/** What a customer sees when we have nothing safe and specific to tell them. */
export const DEFAULT_PUBLIC_ERROR = 'Something went wrong on our side. Please try again in a moment.';

const MAX_LEN = 300;

// Text that is useful to someone probing the platform and to nobody else.
const INTERNAL_TEXT: RegExp[] = [
  /\brelation "[^"]*"|\bcolumn "[^"]*"|\btable "[^"]*"|\bconstraint "[^"]*"|violates [a-z ]*constraint/i,
  /\bSQLSTATE\b|\bduplicate key value\b|\binvalid input syntax\b|\bsyntax error at or near\b|\bpermission denied for\b/i,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENOENT|EACCES|EPIPE)\b/,
  /^(?:fetch failed|socket hang up|terminated|other side closed|network error|aborted)\.?$/i, // Node's own bare network messages
  /\bpassword authentication failed\b|\bno pg_hba\.conf entry\b|\bconnection terminated\b|\bremaining connection slots\b/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]*@/i, // a URL with credentials in it
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/, // an IPv4 address (with a port)
  /\n\s+at\s+\S+/, // a stack frame
  /(?:^|[\s("'])\/(?:app|usr|home|var|opt|node_modules)\/\S+/, // a server file path
  /\b(?:[A-Z][A-Z0-9]*_)+(?:KEY|SECRET|TOKEN|URL|URI|HOST|PASSWORD|ID)\b/, // a setting name such as NANGO_SECRET_KEY
];

function isDriverOrSystemError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; severity?: unknown; routine?: unknown; syscall?: unknown; errno?: unknown };
  // pg errors carry severity/routine; Node system errors carry syscall/errno.
  return typeof e.code === 'string' && (e.severity !== undefined || e.routine !== undefined || e.syscall !== undefined || e.errno !== undefined);
}

/**
 * The text of a caught error that is safe to show a customer, or `fallback`.
 *
 * Kept: what a person can act on — a provider's "Invalid OAuth access token", our own "Billing is not
 * configured". Replaced: database and network error text, connection strings, addresses, stack frames, file
 * paths and setting names. The caller still logs the real error; this only decides what leaves the server.
 */
export function publicErrorMessage(err: unknown, fallback: string = DEFAULT_PUBLIC_ERROR): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const message = raw.trim();
  if (!message) return fallback;
  if (isDriverOrSystemError(err)) return fallback;
  if (INTERNAL_TEXT.some((re) => re.test(message))) return fallback;
  return message.slice(0, MAX_LEN);
}
