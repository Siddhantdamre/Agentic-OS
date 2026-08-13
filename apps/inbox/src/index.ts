import 'dotenv/config';
import crypto from 'crypto';
import express, { Request, Response } from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3004;
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.CHATWOOT_WEBHOOK_SECRET || process.env.INBOX_GATEWAY_SECRET || '';

app.use(cors());
app.use(express.json());

function signBody(raw: string): Record<string, string> {
  if (!WEBHOOK_SECRET) return {};
  const hex = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  return { 'x-chatwoot-signature': `sha256=${hex}` };
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'darex-inbox-chatwoot-gateway',
    timestamp: new Date().toISOString(),
    dashboardUrl: DASHBOARD_URL,
  });
});

app.post('/webhook/inbound', async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const payload = req.body;
    const raw = JSON.stringify(payload);
    const orgId =
      (typeof req.query.org_id === 'string' && req.query.org_id) ||
      (typeof req.headers['x-darex-org-id'] === 'string' && req.headers['x-darex-org-id']) ||
      '';
    const targetUrl = orgId
      ? `${DASHBOARD_URL}/api/webhooks/chatwoot?org_id=${encodeURIComponent(orgId)}`
      : `${DASHBOARD_URL}/api/webhooks/chatwoot`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...signBody(raw),
    };
    if (orgId) headers['X-Darex-Org-Id'] = orgId;

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: raw,
    });

    const data = await response.json().catch(() => ({}));
    res.status(response.status).json({
      success: response.ok,
      inboxGatewayLatencyMs: Date.now() - startTime,
      forwardedTo: targetUrl,
      dashboardResponse: data,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Darex Inbox Gateway] Error forwarding webhook:', message);
    res.status(500).json({ error: message });
  }
});

app.post('/api/inbox/send', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const raw = JSON.stringify(payload);
    const response = await fetch(`${DASHBOARD_URL}/api/webhooks/outbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...signBody(raw),
      },
      body: raw,
    });
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Darex Inbox Gateway] outbound send error:', message);
    res.status(502).json({ success: false, error: message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Darex Chatwoot Inbox Gateway listening on port ${PORT}`);
});
