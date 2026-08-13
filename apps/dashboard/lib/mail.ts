export async function sendTransactionalEmail(opts: {
  to: string;
  subject: string;
  text: string;
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
