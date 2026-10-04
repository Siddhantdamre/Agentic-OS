import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

// Load root .env and dashboard .env.local for local dev & worker execution
const possibleEnvs = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
  path.resolve(process.cwd(), '../.env'),
  path.resolve(process.cwd(), '../../apps/dashboard/.env.local'),
  path.resolve(process.cwd(), 'apps/dashboard/.env.local'),
];
for (const p of possibleEnvs) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
  }
}

import { Worker, NativeConnection } from '@temporalio/worker';
import { Client } from '@temporalio/client';
import * as activities from './activities/index.js';
import { assertEmbeddingWorkerConfig } from './activities/embed.js';
import { bootstrapPeriodicSweeps } from './periodic-registry.js';
import { startBillingSweep } from './billing/sweep-starter.js';
import { startDlqRetention } from './dlq-retention-starter.js';
import { startDsrReaper } from './dsr-reaper-starter.js';
import {
  ensureTrueForgeModelProvider,
  ensureTrueForgeMcpServer,
  ensureDarexAgent,
} from './trueforge-client.js';


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let workerReady = false;

function startHealthServer(): void {
  const port = Number(process.env.WORKER_HEALTH_PORT || 8788);
  if (!Number.isFinite(port) || port <= 0) return;
  const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url === '/health' || url.startsWith('/health?')) {
      const ok = workerReady;
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'text/plain' });
      res.end(ok ? 'ok' : 'not-ready');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, '0.0.0.0');
}

async function runWorker() {
  startHealthServer();
  // Prod fail-fast: unset EMBEDDING_MODEL kills this process, not webhooks.
  assertEmbeddingWorkerConfig();

  const temporalHost = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  let delayMs = 2000;

  for (;;) {
    console.log(`Starting DareX Temporal Autonomous Agent Worker connecting to ${temporalHost}...`);
    try {
      const connection = await NativeConnection.connect({ address: temporalHost });
      // Workflows registered via workflows/index.ts on this queue:
      //   AutonomousAgentWorkflow, CrewWorkflow, WorkItemWorkflow (O2 wrap),
      //   EmbedWorkflow (M2 — additive), MemoryWriteBackWorkflow (M4 child),
      //   IngestWorkflow / SyncWorkflow (K1–K3 — additive),
      //   PlanExecuteWorkflow (O4), OwnerBriefingWorkflow + StaleChaseWorkflow (O5),
      //   NurtureWorkflow (O6), InsightActionWorkflow (A3),
      //   InstallPackWorkflow + ShowingScheduleWorkflow + ShowingReminderWorkflow + RentReminderWorkflow (WS-21).
      // Do not replace this worker or swap the task queue.
      const worker = await Worker.create({
        connection,
        workflowsPath: require.resolve('./workflows/index.js'),
        activities,
        taskQueue: 'darex-agent-tasks',
      });

      console.log('Temporal Agent Worker connected and listening on task queue: "darex-agent-tasks"');
      workerReady = true;
      delayMs = 2000;
      // Seed TrueForge: model provider, MCP server, and the darex-ai named agent.
      // These are idempotent — safe to run on every restart.
      try {
        await ensureTrueForgeModelProvider();
        await ensureTrueForgeMcpServer();
        await ensureDarexAgent();
      } catch (seedErr: unknown) {
        const msg = seedErr instanceof Error ? seedErr.message : String(seedErr);
        console.warn(`TrueForge seed skipped: ${msg}`);
      }
      try {
        await bootstrapPeriodicSweeps(new Client({ connection }));
      } catch (bootErr: unknown) {
        const msg = bootErr instanceof Error ? bootErr.message : String(bootErr);
        console.warn(`Periodic employee sweeps boot skipped: ${msg}`);
      }
      try {
        await startBillingSweep(new Client({ connection }));
      } catch (bootErr: unknown) {
        const msg = bootErr instanceof Error ? bootErr.message : String(bootErr);
        console.warn(`Billing meter sweep boot skipped: ${msg}`);
      }
      try {
        await startDlqRetention(new Client({ connection }));
      } catch (bootErr: unknown) {
        const msg = bootErr instanceof Error ? bootErr.message : String(bootErr);
        console.warn(`DLQ retention sweep boot skipped: ${msg}`);
      }
      try {
        await startDsrReaper(new Client({ connection }));
      } catch (bootErr: unknown) {
        const msg = bootErr instanceof Error ? bootErr.message : String(bootErr);
        console.warn(`DSR reaper sweep boot skipped: ${msg}`);
      }
      await worker.run();
      workerReady = false;
      return;
    } catch (err: any) {
      workerReady = false;
      console.error('Worker failed to connect to Temporal Server:', err.message);
      console.log(`Retrying in ${Math.round(delayMs / 1000)}s...`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 30000);
    }
  }
}

runWorker().catch((err) => {
  console.error('Fatal Worker Error:', err);
  process.exit(1);
});
