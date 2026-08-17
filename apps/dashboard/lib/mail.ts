/**
 * Transactional email via Resend (B1).
 *
 * Env:
 *   RESEND_API_KEY — when set, sending is the default path. Invite APIs
 *     still always return a copyable URL if send fails or the key is unset.
 *   MAIL_FROM — RFC 5322 From, e.g. `Darex <noreply@yourdomain.com>`.
 *     Required in production whenever RESEND_API_KEY is set. Unset MAIL_FROM
 *     in production skips the send (the invite URL remains copyable).
 */

export function isMailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendTransactionalEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!apiKey) {
    return { sent: false, reason: 'RESEND_API_KEY not configured' };
  }
  if (!from) {
    if (process.env.NODE_ENV === 'production') {
      return { sent: false, reason: 'MAIL_FROM must be set in production' };
    }
  }
  const fromAddr = from || 'Darex <noreply@localhost>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddr,
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, reason: `Resend ${res.status} ${body.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : 'send failed' };
  }
}

export function appBaseUrl(fallbackOrigin?: string): string {
  return process.env.NEXT_PUBLIC_APP_URL || fallbackOrigin || 'http://localhost:3000';
}

/** Invite email. Always include the copyable URL in the body (B1). */
export async function sendInviteEmail(opts: {
  to: string;
  orgName: string;
  role: string;
  inviteUrl: string;
  ttlDays: number;
}): Promise<{ sent: boolean; reason?: string }> {
  const text = [
    `You were invited to join ${opts.orgName} as ${opts.role}.`,
    `Accept the invite: ${opts.inviteUrl}`,
    `This link expires in ${opts.ttlDays} days.`,
    `If the button in your mail client is missing, copy the URL above.`,
  ].join('\n');
  const html = `
    <p>You were invited to join <strong>${escapeHtml(opts.orgName)}</strong> as ${escapeHtml(opts.role)}.</p>
    <p><a href="${escapeHtml(opts.inviteUrl)}">Accept the invite</a></p>
    <p>Or copy this URL: <code>${escapeHtml(opts.inviteUrl)}</code></p>
    <p>This link expires in ${opts.ttlDays} days.</p>
  `.trim();
  return sendTransactionalEmail({
    to: opts.to,
    subject: `You were invited to ${opts.orgName} on Darex`,
    text,
    html,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
