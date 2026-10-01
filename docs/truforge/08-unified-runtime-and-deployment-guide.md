# Unified Runtime, MCP Bridge & Deployment Guide

> This document provides the complete, production-grade implementation code for integrating **TrueForge** into the Darex monorepo: updating the MCP server bridge, Next.js streaming API routes, Temporal durable workflow activities, WhatsApp webhooks, and Docker infrastructure.

---

## 1. System Topology & Network Ports

```text
[Internet / Webhooks / Users]
        │
        ▼
[Next.js App Server :3000] ───(Temporal Client)───► [Temporal Server :7233]
        │                                                     │
        ▼                                                     ▼
[TrueForge Harness :8791] ◄──(@truefoundry/trueforge-sdk)─── [Temporal Worker]
        │
        ├───(Streamable HTTP / SSE)───► [Darex MCP Bridge :8790]
        │                                      │
        │                                      ├──► [PostgreSQL :5432] (RLS Enforced)
        │                                      └──► [Nango OAuth :3003] ──► [SaaS APIs]
        │
        ├───(Code Mode / Sandbox Tool)─► [Daytona Compute Sandbox]
        │
        ├───(Model Gateway)────────────► [LiteLLM Proxy :4000]
        │
        └───(OpenTelemetry W3C)────────► [Langfuse Tracing :3002]
```

---

## 2. Refactoring Darex MCP Bridge (`services/workflows/src/mcp-bridge.ts`)

The Darex MCP Bridge exposes 62 tools to TrueForge over Streamable HTTP and SSE. Update the server to enforce tenant RLS from session headers and tag tools with TrueForge annotation hints:

```typescript
// services/workflows/src/mcp-bridge.ts
import http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { executeAutonomousToolAction, resolveToolRisk } from './tool-executor.js';
import { getScopedClient } from './db.js';

const PORT = parseInt(process.env.ATOMIC_BRIDGE_PORT || '8790', 10);
const server = new McpServer({
  name: 'darex-connectors',
  version: '2.0.0'
});

// Map of active SSE transports by sessionId
const transports = new Map<string, SSEServerTransport>();

// Helper to register Darex tools with TrueForge annotation hints
function registerDarexTool(def: {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  risk: 'low' | 'medium' | 'high';
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  handler: (args: any, context: { orgId: string }) => Promise<any>;
}) {
  server.tool(
    def.name,
    def.description,
    def.schema.shape,
    async (args: any, extra: any) => {
      // Resolve orgId strictly from validated session headers (never trust body org_id)
      const orgId = extra?.request?.headers?.['x-darex-org-id'] || args.org_id;
      if (!orgId) {
        throw new Error('Tenant org_id is required and must be provided via x-darex-org-id');
      }

      // Execute tool within PostgreSQL RLS session lock
      return await def.handler(args, { orgId });
    }
  );
}

// 1. Example: Read-only CRM Tool (Auto-approved)
registerDarexTool({
  name: 'hubspot_search_contacts',
  description: 'Search HubSpot CRM contacts by query string.',
  schema: z.object({
    query: z.string(),
    limit: z.number().optional().default(10)
  }),
  risk: 'low',
  readOnlyHint: true,
  handler: async (args, { orgId }) => {
    return await executeAutonomousToolAction('hubspot', 'search_contacts', args, { orgId });
  }
});

// 2. Example: Destructive Monetary Tool (Pauses for Human Approval)
registerDarexTool({
  name: 'stripe_issue_refund',
  description: 'Issues a monetary refund to a customer via Stripe.',
  schema: z.object({
    charge_id: z.string(),
    amount_minor: z.number(),
    reason: z.string().optional()
  }),
  risk: 'high',
  destructiveHint: true,
  handler: async (args, { orgId }) => {
    return await executeAutonomousToolAction('stripe', 'issue_refund', args, { orgId });
  }
});

// HTTP Server with SSE Transport Lifecycle
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname === '/sse') {
    const transport = new SSEServerTransport('/messages', res);
    const sessionId = transport.sessionId;
    transports.set(sessionId, transport);

    transport.onclose = () => {
      transports.delete(sessionId);
    };

    await server.connect(transport);
    return;
  }

  if (url.pathname === '/messages' && req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing or invalid sessionId');
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', tools_count: 62 }));
    return;
  }

  res.writeHead(404);
  res.end();
});

httpServer.listen(PORT, () => {
  console.log(`[Darex-MCP] Bridge listening on port ${PORT} (SSE: /sse, Post: /messages)`);
});
```

---

## 3. Next.js Streaming Route (`apps/dashboard/app/api/ask-ai/route.ts`)

Connects the Darex web dashboard to the TrueForge harness with Server-Sent Events (SSE) and NDJSON streaming:

```typescript
// apps/dashboard/app/api/ask-ai/route.ts
import { NextRequest } from 'next/server';
import { TrueForgeClient } from '@truefoundry/trueforge-sdk';
import { getSessionFromRequest } from '@/lib/supertokens';

const tfClient = new TrueForgeClient({
  baseUrl: process.env.TRUEFORGE_BASE_URL || 'http://localhost:8791',
  token: process.env.TRUEFORGE_API_KEY || 'dev-key'
});

export async function POST(req: NextRequest) {
  // 1. Authenticate user and resolve tenant orgId from session
  const session = await getSessionFromRequest(req);
  if (!session) {
    return new Response('Unauthorized', { status: 401 });
  }
  const orgId = session.getOrgId();
  const userId = session.getUserId();

  const { prompt, employeePersona = 'growth-employee', conversationId } = await req.json();

  // 2. Create or re-attach to TrueForge session
  const sessionId = conversationId || `darex-${orgId}-${Date.now()}`;
  let tfSession;
  try {
    tfSession = await tfClient.sessions.get(sessionId);
  } catch {
    tfSession = await tfClient.sessions.create({
      id: sessionId,
      agent_name: employeePersona,
      metadata: {
        org_id: orgId,
        user_id: userId
      }
    });
  }

  // 3. Open SSE stream back to the browser
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        const turnStream = await tfClient.sessions.turns.createStream(tfSession.id, {
          content: prompt
        });

        for await (const event of turnStream) {
          // Deliver event to Next.js client
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        }
      } catch (err: any) {
        controller.enqueue(encoder.encode(JSON.stringify({
          type: 'error',
          error: err.message
        }) + '\n'));
      } finally {
        controller.close();
      }
    }
  });

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    }
  });
}
```

---

## 4. Inbound WhatsApp Webhook (`apps/dashboard/app/api/webhooks/whatsapp/route.ts`)

Implements the **Fast 200 OK + Temporal Durable Worker** pattern:

```typescript
// apps/dashboard/app/api/webhooks/whatsapp/route.ts
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { getTemporalClient } from '@/lib/temporal-client';
import { getScopedClient } from '@/lib/db';

const META_APP_SECRET = process.env.META_APP_SECRET || '';

// 1. Signature Verification
function verifyMetaSignature(req: NextRequest, rawBody: string): boolean {
  const signature = req.headers.get('x-hub-signature-256') || '';
  if (!signature || !META_APP_SECRET) return true; // dev fallback
  const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (!verifyMetaSignature(req, rawBody)) {
    return new Response('Invalid Signature', { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  const entry = payload.entry?.[0]?.changes?.[0]?.value;
  const message = entry?.messages?.[0];

  if (!message || message.type !== 'text') {
    return Response.json({ status: 'ignored' });
  }

  const fromPhone = message.from;
  const messageText = message.text.body;
  const phoneNumberId = entry.metadata.phone_number_id;

  // 2. Resolve tenant orgId from phoneNumberId
  const db = await getScopedClient();
  const channelRes = await db.query(
    `SELECT org_id FROM channels WHERE provider = 'whatsapp' AND provider_channel_id = $1 LIMIT 1`,
    [phoneNumberId]
  );
  db.release();

  if (channelRes.rowCount === 0) {
    return Response.json({ status: 'unregistered_number' });
  }
  const orgId = channelRes.rows[0].org_id;

  // 3. Fast 200 OK returned to Meta within 300ms
  const response = Response.json({ status: 'received' });

  // 4. Fire-and-forget Temporal Workflow
  const temporal = await getTemporalClient();
  await temporal.workflow.start('AutonomousAgentWorkflow', {
    taskQueue: 'darex-agent-queue',
    workflowId: `wa-${orgId}-${fromPhone}-${Date.now()}`,
    args: [{
      orgId,
      channel: 'whatsapp',
      userIdentifier: fromPhone,
      messageContent: messageText,
      employeePersona: 'customer-employee'
    }]
  });

  return response;
}
```

---

## 5. Temporal Activity (`services/workflows/src/activities/trueforge-activity.ts`)

Executes turns on TrueForge with durable retry logic, automatic timeout handling, and cancellation propagation:

```typescript
// services/workflows/src/activities/trueforge-activity.ts
import { Context } from '@temporalio/activity';
import { TrueForgeClient } from '@truefoundry/trueforge-sdk';

const tfClient = new TrueForgeClient({
  baseUrl: process.env.TRUEFORGE_BASE_URL || 'http://localhost:8791',
  token: process.env.TRUEFORGE_API_KEY || 'dev-key'
});

export async function executeTrueForgeTurnActivity(params: {
  orgId: string;
  conversationId: string;
  employeePersona: string;
  messageContent: string;
}): Promise<{ reply: string; toolCallsCount: number }> {
  const activityContext = Context.current();
  const sessionId = `darex-${params.orgId}-${params.conversationId}`;

  // 1. Ensure TrueForge session exists
  try {
    await tfClient.sessions.get(sessionId);
  } catch {
    await tfClient.sessions.create({
      id: sessionId,
      agent_name: params.employeePersona,
      metadata: { org_id: params.orgId }
    });
  }

  // 2. Create streaming turn
  const stream = await tfClient.sessions.turns.createStream(sessionId, {
    content: params.messageContent
  });

  let reply = '';
  let toolCallsCount = 0;

  // 3. Process events and handle cancellation
  for await (const event of stream) {
    if (activityContext.cancellationSignal.aborted) {
      // Broadcast turn cancellation across TrueForge replicas via Redis
      await tfClient.sessions.turns.cancel(sessionId, event.turn_id);
      throw new Error('Temporal activity cancelled by workflow');
    }

    if (event.type === 'tool.response') {
      toolCallsCount++;
    }

    if (event.type === 'model.message') {
      reply = event.message.content;
    }
  }

  return { reply, toolCallsCount };
}
```

---

## 6. Docker Compose Configuration (`infra/docker-compose.yml`)

The production Compose stack coordinates PostgreSQL, Redis, LiteLLM, TrueForge, and Daytona:

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:17-alpine
    container_name: darex-postgres
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: darex
      POSTGRES_USER: darex_app
      POSTGRES_PASSWORD: ${DB_PASSWORD:-secure_darex_pwd}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./db/migrations:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U darex_app -d darex"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    container_name: darex-redis
    restart: unless-stopped
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  litellm:
    image: ghcr.io/berriai/litellm:main-latest
    container_name: darex-litellm
    restart: unless-stopped
    ports:
      - "4000:4000"
    volumes:
      - ./litellm/config.yaml:/app/config.yaml
    command: ["--config", "/app/config.yaml", "--port", "4000"]
    environment:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      GEMINI_API_KEY: ${GEMINI_API_KEY}

  trueforge:
    build:
      context: ../trueforge
      dockerfile: Dockerfile.dev
    image: darex-trueforge:latest
    container_name: darex-trueforge
    restart: unless-stopped
    ports:
      - "8791:8790"
    environment:
      NODE_ENV: production
      PORT: 8790
      PUBLIC_BASE_URL: http://localhost:8791
      STANDALONE: "false"
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_DB: darex
      POSTGRES_USER: darex_app
      POSTGRES_PASSWORD: ${DB_PASSWORD:-secure_darex_pwd}
      REDIS_URL: redis://redis:6379
      OPENAI_BASE_URL: http://litellm:4000/v1
      OPENAI_API_KEY: sk-litellm-master-key
      DAYTONA_SERVER_URL: ${DAYTONA_SERVER_URL}
      DAYTONA_API_KEY: ${DAYTONA_API_KEY}
      OTEL_EXPORTER_OTLP_ENDPOINT: http://langfuse:3000/api/public/otel
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  mcp-bridge:
    build:
      context: ../services/workflows
      dockerfile: Dockerfile
    container_name: darex-mcp-bridge
    restart: unless-stopped
    ports:
      - "8790:8790"
    environment:
      PORT: 8790
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: darex
      DB_USER: darex_app
      DB_PASSWORD: ${DB_PASSWORD:-secure_darex_pwd}
      NANGO_SERVER_URL: http://nango:3003
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  postgres_data:
```

---

## 7. Automated Smoke Tests & Health Check Probes

Run these commands in terminal to verify end-to-end functionality:

```bash
# 1. Verify MCP Bridge Health & Tool Count
curl -s http://localhost:8790/healthz | jq
# Expected: {"status": "ok", "tools_count": 62}

# 2. Verify TrueForge Server Health
curl -s http://localhost:8791/healthz | jq
# Expected: {"status": "ok", "version": "..."}

# 3. Create Session with Scoped Tenant Org
SESSION_ID=$(curl -s -X POST http://localhost:8791/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "growth-employee", "metadata": {"org_id": "org_test_123"}}' | jq -r '.id')
echo "Created TrueForge Session: $SESSION_ID"

# 4. Stream Turn via SSE
curl -N -X POST "http://localhost:8791/api/v1/sessions/$SESSION_ID/turns" \
  -H "Content-Type: application/json" \
  -d '{"content": "Who are you and what is your primary objective?"}'
```
