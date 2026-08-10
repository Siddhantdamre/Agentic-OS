import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3004;
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'darex-inbox-chatwoot-gateway',
    timestamp: new Date().toISOString(),
    dashboardUrl: DASHBOARD_URL,
  });
});

// Inbound message webhook proxy from Chatwoot / Channels -> Dashboard Webhook API
app.post('/webhook/inbound', async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    const payload = req.body;
    console.log('[Darex Inbox Gateway] Inbound Webhook Received:', payload.event || payload.channel || 'generic');

    // Forward to Dashboard Webhook API
    const targetUrl = `${DASHBOARD_URL}/api/webhooks/chatwoot`;
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    const duration = Date.now() - startTime;

    res.status(response.status).json({
      success: response.ok,
      inboxGatewayLatencyMs: duration,
      forwardedTo: targetUrl,
      dashboardResponse: data,
    });
  } catch (err: any) {
    console.error('[Darex Inbox Gateway] Error forwarding webhook:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Outbound message proxy to external channels
app.post('/api/inbox/send', (req: Request, res: Response) => {
  const { conversationId, channel, recipient, content } = req.body;
  console.log(`[Darex Inbox Gateway] Sending outbound message on ${channel} to ${recipient}: ${content}`);

  res.json({
    success: true,
    status: 'sent',
    channel,
    recipient,
    conversationId,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Darex Chatwoot Inbox Gateway listening on port ${PORT}`);
});
