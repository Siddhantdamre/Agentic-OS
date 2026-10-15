/**
 * Browser protections sent with every response (applied in next.config.js).
 *
 * The content policy is deliberately small: it forbids framing, plugins and a rewritten <base>, and says nothing
 * about scripts, styles, connections or forms, so it cannot break the app, its inline load guard or the sign-in
 * redirects. The widget customers put on their own sites is a script, not a framed page, so nothing here blocks it.
 */
function securityHeaders({ production }) {
  const headers = [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  ];
  // Browsers ignore this over plain http, but a local http start should not be told to remember it.
  if (production) headers.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' });
  return headers;
}

module.exports = { securityHeaders };
