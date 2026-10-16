'use strict';
// Preloaded into the harness copy of the dashboard server (NODE_OPTIONS=--require). Sends calls that would
// leave the machine for a known provider host to the fake world instead. Nothing else is touched.
const WORLD = process.env.WORLD_URL || 'http://127.0.0.1:4999';
const HOSTS = new Set(['gmail.googleapis.com', 'www.googleapis.com', 'oauth2.googleapis.com', 'graph.microsoft.com', 'slack.com', 'api.razorpay.com', 'graph.facebook.com', 'api.hubapi.com', 'api.stripe.com']);
const real = globalThis.fetch;
globalThis.fetch = function patched(input, init) {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input && input.url;
    if (raw && /^https:\/\//.test(raw)) {
      const u = new URL(raw);
      if (HOSTS.has(u.hostname)) {
        const to = `${WORLD}/provider/${u.hostname}${u.pathname}${u.search}`;
        return real(typeof input === 'object' && 'url' in input && !(input instanceof URL) ? new Request(to, input) : to, init);
      }
    }
  } catch { /* fall through to the real fetch */ }
  return real(input, init);
};
