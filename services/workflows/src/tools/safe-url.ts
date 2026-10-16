import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import zlib from 'node:zlib';

/**
 * Outbound fetch guard for URLs a model or user supplied (WEB-S01).
 *
 * The string check alone is not enough: a public-looking name can resolve to
 * 127.0.0.1, and a public page can redirect to the metadata endpoint. So every
 * hop is checked as a string, and every address is checked again inside the
 * socket's DNS lookup, which means the address we check is the address we
 * connect to (no resolve-then-rebind gap).
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64 embeds IPv4
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32], // Teredo
  ['2001:db8::', 32],
  ['2002::', 16], // 6to4 embeds IPv4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10],
  ['ff00::', 8], // multicast
] as const) BLOCKED.addSubnet(net, prefix, 'ipv6');

const INTERNAL_HOSTS = new Set([
  'sandbox', 'postgres', 'redis', 'temporal', 'litellm', 'cognee', 'hindsight', 'trueforge',
  'mcp-bridge', 'atomic-bridge', 'dashboard', 'inbox', 'metadata.google.internal',
]);

/** `::ffff:127.0.0.1` / `::ffff:7f00:1` → `127.0.0.1`; otherwise null. */
function mappedIPv4(v6: string): string | null {
  const m = v6.toLowerCase().match(/^(?:0{0,4}:){0,5}:?ffff:(.+)$/);
  if (!m) return null;
  const tail = m[1];
  if (isIP(tail) === 4) return tail;
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True when an IP address is private, loopback, link-local, reserved or multicast. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    const v4 = mappedIPv4(address);
    if (v4) return BLOCKED.check(v4, 'ipv4');
    return BLOCKED.check(address, 'ipv6');
  }
  return true;
}

/** Host exactly as written in the input, before WHATWG normalisation. */
function rawHost(rawUrl: string): string {
  const m = rawUrl.trim().match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i);
  return (m?.[1] || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/**
 * String-level policy: scheme, credentials, internal names, IP literals.
 * Returns the parsed URL or throws UnsafeUrlError. Does no network I/O.
 */
export function checkPublicUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('Invalid URL format');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError('Only HTTP and HTTPS URLs are permitted');
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError('URLs with embedded credentials are not permitted');
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(host)) {
    // new URL() turns 0x7f.1, 2130706433 and 0177.0.0.1 into 127.0.0.1; an
    // address written any way other than its canonical form is an evasion.
    if (rawHost(rawUrl) !== host) throw new UnsafeUrlError('Non-canonical IP address literals are not permitted');
    if (isBlockedAddress(host)) throw new UnsafeUrlError('Access to private, loopback or reserved addresses is prohibited');
    return parsed;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new UnsafeUrlError('Access to loopback addresses is prohibited');
  }
  if (INTERNAL_HOSTS.has(host) || host.endsWith('.internal') || host.endsWith('.local') || !host.includes('.')) {
    throw new UnsafeUrlError('Access to internal network hostnames is prohibited');
  }
  return parsed;
}

type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

const systemLookupAll: LookupAll = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

/** Resolve every A/AAAA record and reject if any of them is non-public. */
export async function resolvePublicAddresses(
  hostname: string,
  lookupAll: LookupAll = systemLookupAll,
  isBlocked: (address: string) => boolean = isBlockedAddress,
): Promise<LookupAddress[]> {
  let addresses: LookupAddress[];
  try {
    addresses = await lookupAll(hostname);
  } catch (err) {
    throw new UnsafeUrlError(`Could not resolve ${hostname}: ${(err as Error).message}`);
  }
  if (addresses.length === 0) throw new UnsafeUrlError(`${hostname} did not resolve`);
  const bad = addresses.find((entry) => isBlocked(entry.address));
  if (bad) throw new UnsafeUrlError(`${hostname} resolves to a private or reserved address`);
  return addresses;
}

/** Full pre-flight check: string policy plus DNS. */
export async function assertPublicUrl(rawUrl: string, lookupAll: LookupAll = systemLookupAll): Promise<URL> {
  const parsed = checkPublicUrl(rawUrl);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host)) await resolvePublicAddresses(host, lookupAll);
  return parsed;
}

function guardedLookup(lookupAll: LookupAll, isBlocked: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolvePublicAddresses(hostname, lookupAll, isBlocked).then(
      (addresses) => {
        const wanted = options.family === 4 || options.family === 6 ? addresses.filter((a) => a.family === options.family) : addresses;
        const usable = wanted.length ? wanted : addresses;
        if (options.all) (callback as (e: null, a: LookupAddress[]) => void)(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      },
      (err) => callback(err as NodeJS.ErrnoException, '', 0),
    );
  };
}

export interface SafeGetOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Test seam; defaults to the system resolver. */
  lookupAll?: LookupAll;
  /** Test seam for resolved addresses; defaults to isBlockedAddress. Literal hosts always use the default. */
  isBlocked?: (address: string) => boolean;
}

export interface SafeGetResponse {
  ok: boolean;
  status: number;
  url: string;
  contentType: string;
  body: string;
  truncated: boolean;
  /** Set when the response was rejected due to a disallowed Content-Type. */
  rejectedContentType?: boolean;
}

const ALLOWED_CONTENT_TYPE_RE = /text\/|application\/(json|pdf)/;

function isAllowedContentType(ct: string): boolean {
  return ALLOWED_CONTENT_TYPE_RE.test(ct);
}

function requestOnce(url: URL, opts: Required<SafeGetOptions>) {
  return new Promise<{ status: number; location?: string; contentType: string; body: string; truncated: boolean; rejectedContentType?: boolean }>((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: { 'Accept-Encoding': 'gzip, deflate, br', ...opts.headers },
      lookup: guardedLookup(opts.lookupAll, opts.isBlocked),
      timeout: opts.timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      const contentType = String(res.headers['content-type'] || '');
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ status, location: String(res.headers.location), contentType, body: '', truncated: false });
        return;
      }
      if (!isAllowedContentType(contentType)) {
        res.resume();
        resolve({ status, contentType, body: '', truncated: false, rejectedContentType: true });
        return;
      }
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = encoding === 'gzip' ? res.pipe(zlib.createGunzip())
        : encoding === 'deflate' ? res.pipe(zlib.createInflate())
          : encoding === 'br' ? res.pipe(zlib.createBrotliDecompress())
            : res;
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      stream.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = opts.maxBytes - size;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          size = opts.maxBytes;
          truncated = true;
          req.destroy();
          resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8'), truncated });
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      stream.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8'), truncated }));
      stream.on('error', (err) => { if (!truncated) reject(err); });
    });
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${opts.timeoutMs}ms`)));
    req.on('error', reject);
  });
}

/**
 * GET a URL that came from outside the platform. Every redirect hop is
 * re-checked, every resolved address is checked at connect time, and the
 * decoded body is capped. Throws UnsafeUrlError on a policy violation.
 */
export async function safeGet(rawUrl: string, options: SafeGetOptions = {}): Promise<SafeGetResponse> {
  const opts: Required<SafeGetOptions> = {
    headers: options.headers || {},
    timeoutMs: options.timeoutMs ?? 10_000,
    maxBytes: options.maxBytes ?? 5 * 1024 * 1024,
    maxRedirects: options.maxRedirects ?? 5,
    lookupAll: options.lookupAll || systemLookupAll,
    isBlocked: options.isBlocked || isBlockedAddress,
  };
  let current = checkPublicUrl(rawUrl);
  for (let hop = 0; ; hop += 1) {
    const res = await requestOnce(current, opts);
    if (res.location === undefined) {
      return {
        ok: !res.rejectedContentType && res.status >= 200 && res.status < 300,
        status: res.status,
        url: current.toString(),
        contentType: res.contentType,
        body: res.body,
        truncated: res.truncated,
        ...(res.rejectedContentType ? { rejectedContentType: true } : {}),
      };
    }
    if (hop >= opts.maxRedirects) throw new UnsafeUrlError(`Too many redirects (>${opts.maxRedirects})`);
    let next: string;
    try {
      next = new URL(res.location, current).toString();
    } catch {
      throw new UnsafeUrlError('Redirect to an invalid URL');
    }
    current = checkPublicUrl(next);
  }
}
